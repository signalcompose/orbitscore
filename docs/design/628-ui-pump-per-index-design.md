# 設計書: `UiEventPump` の per-index 化（issue #628・owner 決定 A）

> 起案: Fable subagent（2026-08-28）。実装は含まない。
> 本書は `docs/design/628-rack-chain-implementation-design.md`（以下「実装設計書」）の
> **§3.1-(6) の 2 番目の bullet・§3.4-(5)・決定表 #12 を置き換える**。差し替えの明細は §0.2。
>
> 🔴 本書の前提事実はすべて実ファイルで確認し、ファイル名と行番号を添えた。
> 確認していない項目は §0.4 に「未確認」として隔離した。「自然対応する」の類の
> 未検証前提は書いていない。

---

## 0. 対象と経緯

### 0.1 何が壊れているか（実コードで確認済み）

child 側は多重ウィンドウ化済み・daemon 側は単一 lifecycle のまま、という非対称がある。

**child 側（実装済み・本ブランチ）**:

- `orbit-child-runtime/src/ui_service.rs:184-201` — `UiEventHub` は「1 rack child 内の全
  indexed UI が共有する単一イベント発行器」。`ui_service.rs:342-364` の
  `UiService::new_indexed` が stage index 付きの UI サービスを作る
- close event は arg に index を積む（`ui_service.rs:101-118` `event_arg`）:
  - `EVT_UI_CLOSED` → `{"index":n}`
  - `EVT_UI_CLOSED_DONE` → `{"index":n,"completion":"safepoint-completed"}` /
    `{"index":n,"completion":"timeout-without-save"}`
  - 非 indexed（instrument / 旧単発 child）は従来形（空文字 / 素の completion 文字列）
- indexed UI の open は child 側で冪等（`ui_service.rs:463` `idempotent_open: index.is_some()`、
  `ui_service.rs:505` で `ALREADY_OPEN_DETAIL` を `CMD_RESULT_OK` に変換）
- rack child は `CMD_OPEN_UI_AT` / `CMD_CLOSE_UI_AT` を現在の stage 位置で routing する
  （`orbit-effect-rack-child/src/lib.rs:766-781` `handle_ui_at` = `self.stages.get(index)`）。
  APPLY commit 時、keep された stage には `set_index(new)` が呼ばれ（`lib.rs:730`）、drop
  された stage は防御的に close される（`lib.rs:733-736`）

**daemon 側（未対応・本設計の対象）**:

- `orbit-audio-sandbox/src/transport.rs:1249-1256` — `UiPumpState` は
  `generation` / `pending_safepoint` / `abandoned_safepoint` / `lifecycle` を**各 1 つ**持つ
- `transport.rs:1326-1339` — `begin_open()` は `lifecycle != Closed` を loud に拒否
  = **1 child につき UI 1 枚**
- `transport.rs:1395-1409` — `poll_step` の `EVT_UI_CLOSED_DONE` 腕は arg を
  `"safepoint-completed"` / `"timeout-without-save"` の**完全一致**でしか受理しない。
  rack child の indexed arg `{"index":n,"completion":"…"}` は Protocol error になり、
  **イベントが ack されないままリング先頭が永久に詰まる**（`poll_step` はエラーで打ち切り、
  watchdog は毎 tick 失敗ログを吐き続ける）。つまり現状は「2 枚目が開けない」だけでなく、
  **rack child の 1 枚目の close も完走しない**
- `transport.rs:1576-1585` — `is_abandon_done_published` も arg 完全一致
  （`Some("timeout-without-save")`）なので、rack child では timeout 放棄エスケープも壊れる
- `orbit-audio-daemon/src/engine_wrap.rs:2797-2801` — `PluginUiWiring.target` は
  `Arc<Mutex<Option<PluginUiTarget>>>`（**単一 route**）。`engine_wrap.rs:2810-2863`
  `enqueue_plugin_ui_notification` は Safepoint で clone・CloseDone で take する
- `engine_wrap.rs:5634-5686` `open_outproc_plugin_ui` は `pump.begin_open()`（index なし）→
  route 単一代入 → rack なら `issue_open_ui_at`。`engine_wrap.rs:5721-5764`
  `ack_outproc_ui_safepoint` は wire から index を受け取り route と照合するが、
  `pump.ack_safepoint(generation, evt_seq)` には **index を渡していない**

### 0.2 実装設計書からの差し替え箇所

| 箇所 | 旧記述 | 本書での扱い |
|---|---|---|
| §3.1-(6) bullet 2 後半 | 「daemon の UI pump / TS の session 簿記は instanceId キー（§3.4-(5)）なので多重に自然対応する」 | **削除**。pump は child 単位の単一 state（§0.1）。本書 §4 が正 |
| §3.4-(5) | 「session キーを instanceId へ変え、close/save 時に現在のチェーンから index を導出」 | **改訂**。session キーは現行 `(daemonTarget, index)` のまま（`global.ts:132` / `global.ts:975-987`）。index 導出は不要になる — 代わりに「open 中 UI の index は不変」不変条件を導入（本書 §4.8） |
| 決定表 #12 | 確信度「高」のまま多重対応を既成事実化 | **置換**。本書 §2 の決定群が正。旧 #12 の他の内容（3 起動経路・`chain_path` 宛先）は有効のまま |

実装設計書のその他のセクション（C15 テスト・`CMD_*_AT` コマンド表・§3.4-(8) の `ui()`
名前形など）は有効のまま。本書はそれらの上に建つ。

### 0.3 実コードで確認した事実の一覧（根拠行番号）

| # | 事実 | 根拠 |
|---|---|---|
| F1 | event ring は child につき 1 本・`evt_seq` は単一カウンタ | `transport.rs:267`（`SharedRegion.evt_seq`）・`transport.rs:83-87`（`EVT_SLOTS = 2`） |
| F2 | ring の publish 容量: seq `s` を publish できるのは `evt_ack >= s - EVT_SLOTS` のとき | `transport.rs:517-531`（`EventRingChild` の service） |
| F3 | `poll_step` は safepoint 通知後 handler が false を返すと**先頭で停止**し、ack されるまで後続イベントを読まない → **pending safepoint は child 全体で高々 1** | `transport.rs:554-575`（`EventPollOutcome` の型注記）・`transport.rs:1387-1397`（false 返却） |
| F4 | `generation` の唯一の増分点は `reset_after_child_exit`（respawn 時・child 全体） | `transport.rs:1473-1501`（`wrapping_add` は `:1491`） |
| F5 | ack の in-order head 検査: `ack + 1 == evt_seq && evt_seq <= published` | `transport.rs:1461-1466` |
| F6 | 既存注記「generation は同一世代内の evt_seq 取り違えまでは守らない」 | `transport.rs:1299-1300` |
| F7 | `abandoned_safepoint` は DONE 後（lifecycle Closed 後）も遅着 ack 受理のため生存する | `transport.rs:1252-1254`・`transport.rs:1446-1453` |
| F8 | 類似機構の前例: mailbox の `InFlightCommand.generation` は「seq 単独で現状足りるが、単調性が他所の不変条件に依存するため併記照合する」 | `transport.rs:866-884` |
| F9 | `orbit-audio-sandbox` は依存隔離ポリシーで serde を持たない（lib は memmap2 のみ） | `orbit-audio-sandbox/Cargo.toml`（冒頭コメント + `[dependencies]`） |
| F10 | `EVT_ARG_BYTES = 256` — indexed DONE arg の最大長（`{"index":4294967295,"completion":"timeout-without-save"}` = 51 byte）は余裕で収まる | `transport.rs:288-290` |
| F11 | child の open 受理は **hub 全体の drain 検査**を含む（他 index の close cycle 進行中は `CLOSING_IN_PROGRESS` 拒否） | `orbit-child-ui/src/lib.rs:207-225`（`open_command`）・`ui_service.rs:176-182`（`is_drained` は hub 全体） |
| F12 | child の close 状態機械: Phase A で `UI_CLOSED` publish → 自 seq の ack か 10 秒 timeout で Phase B（破棄）→ `UI_CLOSED_DONE` | `orbit-child-ui/src/lib.rs:262-320`（`tick`）・`UI_CLOSE_TIMEOUT` は `ui_service.rs:20` |
| F13 | child hub は close cycle を跨いだ publish 順序ゲートを**持たない**（pending FIFO・`queued_in_ring` は publish 完了で即クリア） | `ui_service.rs:127-171`（`try_publish`） |
| F14 | TS の DSL 冪等 open は message アンカー `'OPEN_UI requested while lifecycle is Open'` と `'already-open'` に依存する | `packages/engine/src/core/global.ts:996-1030`（`openPluginUiIdempotent`） |
| F15 | TS session 簿記は `(daemonTarget, index)` キー・identity は open 時に確定し再解決しない（#601 I1） | `global.ts:125-135`・`global.ts:833-855`・`global.ts:1032-1074` |
| F16 | wire の AckUiSafepoint / OpenPluginUI は daemon 側で `chain_path`（省略時 0）を読むが、**TS は chain_path を送っていない**（`index` パラメータは daemon に読まれない） | `orbit-audio-daemon/src/session.rs:323-345`・`session.rs:1981-2020`・TS 側 grep で `chain_path` 出現 0 件（`packages/engine/src` 全 .ts） |
| F17 | daemon → TS のイベントフレームは `PluginUiTarget { role, bus, instance, index }` を運び、TS は `target.index` を echo して ack する | `engine_wrap.rs:7773-7781`・`rust-engine-player.ts:578-599` |
| F18 | respawn 時の UI 整理: `service_ui_pump_on_respawn` → `reset_after_child_exit` → `closed_visible_ui` なら単一 target の `ClosedByRespawn` を配送 | `outproc_respawn_guard.rs:36-57`・`engine_wrap.rs:2865-2880` |
| F19 | TS は respawn クローズ通知で session 簿記を即時破棄する（#619 R2） | `global.ts:216-223`・`rust-engine-player.ts:626-640` |
| F20 | `poll_step` の `EVT_UI_CLOSED` 腕は arg を**読んでいない**（index は現状無視）。DONE 腕だけが arg を読む | `transport.rs:1366-1414` |

### 0.4 未確認事項（設計はこれらに依存しない形にした）

| # | 項目 | 依存しない理由 |
|---|---|---|
| U1 | #628 完了後に非 rack の effect child（単発 CLAP/VST3 child）が残るか | pump のキーを `Option<u32>` にし、`None` = 非 indexed とすることで、残っても残らなくても同じコードが動く（§4.1） |
| U2 | §4.6-(2) の ring デッドロック（机上解析）が実機で再現するか | 実装前に fixture で再現テストを書く（§7-1）。再現しなければ H ゲートは防御実装に格下げしてよいが、テストは残す |
| U3 | `ORBIT_GATED_ORBITSTUDIO` E2E ハーネスが同一 receiver への同名 2 plugin 配置を既にサポートするか | E2E 行（§5 表末尾）は既存ハーネスの範囲で書く。不足があれば実装フェーズで報告 |

---

## 1. 完了条件（曖昧語なし）

1. **同一 rack child 内の 2 つの catalog stage の UI が同時に開く**: `open_outproc_plugin_ui`
   を index 0 と 2 に対して呼ぶと双方 `Ok` を返し、双方のウィンドウ生存中にどちらか一方の
   close（safepoint → ack → DONE）が**他方の lifecycle を変えずに**完走する（unit: fixture
   ring / 実機: gated E2E）。
2. **`ui("A")` の複数一致で全部開く**（SC.10.10.1 規範 2-3・`SIGNAL_CHAIN_DSL_SPEC_v1.md:398`）:
   rack `[A, A]` に対する `ui("A")` で 2 枚のウィンドウが開く gated E2E が green。
3. **indexed arg の受理**: `EVT_UI_CLOSED_DONE` の arg `{"index":n,"completion":"…"}` を
   `poll_step` / `final_drain` / `is_abandon_done_published` が正しく解釈する（§0.1 の
   「1 枚目の close も完走しない」欠陥の解消）。非 indexed の従来 arg も従来どおり受理する。
4. **ack の照合キーは (generation, index, evt_seq)**: 別 index を名乗る ack は loud に
   拒否され、pending は消えない。
5. **respawn reset は開いていた全 index を畳む**: 各 index の `ClosedByRespawn` が TS に届き、
   TS session 簿記（`openPluginUiSessions`）の該当エントリが全て消える。
6. **instrument 経路の観測挙動は不変**: instrument の open / close / safepoint / respawn の
   既存ユニット・gated テストが全て無修正で green（型は共有するが、`None` キー 1 エントリの
   動きは現行の単一 state と同値）。
7. **§5 の失敗モード表の全行が変異で red → restore で green を実証済み**（変異 4 種横断:
   分岐反転 / 回数 / 順序 / 引数）。
8. **同 index への再 open**: DSL 経路（`ui()` / `openPluginUiIdempotent`）では no-op 成功、
   MCP 直接経路では loud 拒否（PH.2c・`INSTRUCTION_ORBITSCORE_DSL.md:1338-1341`）。

---

## 2. ブリーフ §3.2 の 5 問への回答

先に要約表、続いて各根拠。

| 問 | 決定 |
|---|---|
| Q1 generation の粒度 | **child 単位のまま**。index は照合の別次元として持つ |
| Q2 ack の照合キー | **(generation, index, evt_seq) の三つ組**。pending は `(index, evt_seq)` を保持 |
| Q3 複数 Closing の teardown | lifecycle は per-index map。reset は非 Closed の全 index を列挙して返す。`abandoned_safepoint` は **per-index に 1 つ**（map エントリ内の `Option<u64>`） |
| Q4 begin_open の拒否条件 | **当該 index の lifecycle != Closed のときのみ loud 拒否**。別 index は無条件に独立。同 index 冪等は現行どおり **TS 層 + child の already-open→OK** で実現し、pump は冪等化しない |
| Q5 instanceId ↔ (child, index) の写像 | **TS session 簿記が open 時に確定して保持**（現行キー維持）。daemon は identity を持たない。「open 中 UI の index は不変」不変条件（§4.8）で写像の失効を構造的に排除 |

### Q1: generation は child 単位のまま

**根拠**: generation が守っている対象は「respawn で `evt_seq` が 0 に巻き戻った後、旧世代の
ack が新世代の seq に誤ヒットすること」（`transport.rs:1282-1283` のコメント・F4）。
その巻き戻りの単位は **ring**であり、ring は child につき 1 本（F1）。全 index は同一 ring を
共有するので、巻き戻りは常に全 index 同時に起きる。

per-index generation にすると、「respawn で N 個のカウンタを同時に同値だけ進める」という
新しい不変条件を自前で維持する必要が生じる。これは**1 つの事実（ring の世代）を N 個の
状態に複製する**ことであり、複製された状態は乖離しうる — まさに今回の穴（設計と実装の
乖離・検証されない前提）と同型の構造を作る。child 単位 1 本なら乖離のしようがない。

respawn は child 全体を作り直す（`reset_after_child_exit` は全 state を初期化する・F4）ので、
「index ごとに世代が異なる」状況はプロトコル上存在しない。存在しない状況を表現できる型は
不変条件を増やすだけで何も守らない。

### Q2: ack の照合キーは (generation, index, evt_seq)

**現状の保証の棚卸し**（実コード確認済み）:

- pending safepoint は child 全体で高々 1（F3: `poll_step` は safepoint 通知後、ack されるまで
  リング先頭で停止する）
- ack は generation 一致（`transport.rs:1437-1442`）+ pending 一致（`:1455-1459`）+
  in-order head（F5）の三重検査

この 3 つが立っている限り、**evt_seq 単独でも取り違えは起きない**（同時に 2 つの pending が
存在できないため、「別 index の ack」はそもそも pending 不一致で落ちる）。しかし:

1. その十分性は「poll_step が先頭で停止する」という**別の場所の実装詳細**に依存している。
   F8 の `InFlightCommand.generation` と同じ判断構造 — 「現状足りているが、足りている根拠が
   他所にあるなら、照合フィールドを 1 本足して安全側に倒す。フィールド 1 本と比較 1 箇所の
   対価としては安い」（`transport.rs:871-884` の既存コメントの論法をそのまま適用する）
2. F6 の既存注記どおり、generation は同一世代内の取り違えを守らない。index を照合に加える
   ことで、**TS が別ウィンドウの target を echo してしまう類のバグ**（wire 層の取り違え）が
   「別ウィンドウの pending を消して保存を偽装する」silent 事故ではなく loud な Protocol
   error になる
3. wire は既に index を運んでいる（F16/F17: `AckUiSafepoint` は `chain_path` を取り、TS は
   event の `target.index` を echo する）。engine_wrap も index を受けて route 照合している
   （`engine_wrap.rs:5721-5764`）が、**pump まで届けていない**。権威ある pending は pump に
   あるので、照合も pump で行うのが正しい位置

**形**: `pending_safepoint: Option<PendingSafepoint { index: Option<u32>, evt_seq: u64 }>`。
ack は `(generation, index, evt_seq)` を受け、3 つ全一致 + in-order head でのみ前進する。
pending を per-index の map にはしない（§3 却下案 R3）。

### Q3: 複数 Closing の teardown / respawn

- **lifecycle は per-index map**（§4.1）。`EVT_UI_CLOSED` で当該 index を `Closing` に、
  `EVT_UI_CLOSED_DONE` で `Closed` にする。
- **`reset_after_child_exit`**: 非 `Closed` の全 index を収集し
  `UiPumpResetOutcome { closed_indices: Vec<Option<u32>>, generation }` として返す（現行の
  `closed_visible_ui: bool`・`transport.rs:1311-1314` の置換）。呼び出し側
  （`outproc_respawn_guard.rs:36-57`）は route registry の**全エントリを drain** して
  index ごとに `ClosedByRespawn` を配送する（§4.5）。pending safepoint が残っていれば現行
  どおり error ログ（`transport.rs:1480-1487` と同じ）。
- **`abandoned_safepoint` は per-index**: map エントリ内の `Option<u64>`。理由:
  - 放棄は index ごとに独立して起こりうる（index 0 の close が timeout 放棄された後、
    index 2 の close も timeout 放棄されうる）。単一 `Option` のままだと 2 件目が 1 件目を
    上書きし、1 件目の遅着 ack が warn 受理（`transport.rs:1446-1453`）ではなく Protocol
    拒否になる — 「保存は成功していたのに運用者に保存失敗として見える」という、この機構が
    まさに潰した症状（`transport.rs:1587-1592` の warn の存在理由）が per-index 化で再発する
  - 容量は自然に有界: 1 index に高々 1（新しい放棄が同 index の古い放棄を上書きするのは
    現行と同じ意味論）・エントリ総数はチェーン長で抑えられ、respawn reset で全消去
- **エントリの削除規則**: `lifecycle == Closed && abandoned_safepoint == None` になった
  エントリは map から除去する（F7 の「abandoned は Closed 後も生存」を per-index で維持）。

### Q4: begin_open の拒否条件と冪等 open の表現

**pump の状態機械はシンプルに保つ**: `begin_open(index)` は**当該 index** の lifecycle が
`Closed`（= エントリ不在も含む）のときだけ `Opening` を予約し、それ以外は現行と同形の
Protocol error で loud 拒否。別 index の状態は一切見ない。

**同 index 冪等はどこに置くか**: pump には置かない。理由は仕様の非対称にある —
PH.2c（`INSTRUCTION_ORBITSCORE_DSL.md:1338-1341`）は「DSL の `ui()` は冪等 / **MCP の
`open_plugin_ui` は冪等にしない**（明示操作の二重 open は loud）」を要求する。この分岐は
**呼び出し経路の知識**であり、経路を知らない pump に置くと MCP の loud 要件が満たせない。
現行実装は既にこの分担で動いている（実コード確認済み）:

1. TS DSL 層: `openPluginUiIdempotent`（`global.ts:996-1030`）が session 簿記 fast-path +
   「`OPEN_UI requested while lifecycle is Open`」「`already-open`」の 2 アンカーで
   no-op 化（F14）
2. child: indexed UI は `ALREADY_OPEN` を `CMD_RESULT_OK` に変換（`ui_service.rs:505`）—
   TS 簿記と実態がずれた場合の防衛・再同期経路
3. MCP: `openPluginUi`（非冪等版・`global.ts:1032`）を直接呼び、pump の loud 拒否が
   そのまま届く

per-index 化はこの 3 層をそのまま index 次元に広げるだけで、新しい規則を作らない。

**注意（アンカー保全）**: begin_open の拒否文言は F14 の TS アンカーが前方一致で依存して
いる。per-index 化で index を文言に足す場合、**`"OPEN_UI requested while lifecycle is
{:?}"` の並びを先頭に保ち、index は末尾に付加する**
（例: `OPEN_UI requested while lifecycle is Open (stage 2)`）。§5 の P10 で pin する。

### Q5: TS instanceId ↔ daemon (child, index) の写像

**写像の保持者は TS の session 簿記・open 時に確定して以後不変**（#601 I1 の現行ポリシー
そのまま・F15）。各層の持ち物:

| 層 | 保持者 | キー | 生成 / 破棄 |
|---|---|---|---|
| TS session | `Global.openPluginUiSessions`（`global.ts:132`） | `pluginUiSessionKey(daemonTarget, index)`（**現行維持**） | open 成功時に記録（値に `resolved.identity` = instanceId 相当を保持）/ safepoint 保存成功・DONE・respawn で破棄 |
| wire | `chain_path: [n]`（`session.rs:323-345`） | — | open 時: TS が現在チェーンの位置から導出。ack 時: event の `target.index` を echo（F17） |
| daemon route | `PluginUiWiring.target` → **per-index registry**（§4.5） | `Option<u32>` | open 成功時 insert / CloseDone・respawn で remove |
| daemon pump | `UiPumpState.indices`（§4.1） | `Option<u32>` | begin_open で生成 / Closed かつ abandoned なしで除去 |
| child | `stages[current].control`（`orbit-effect-rack-child/src/lib.rs:766-781`） | 現在の stage 位置 | APPLY commit の `set_index` で追随 |

instanceId（SC.5 identity）は **TS より下に流さない**（実装設計書 決定 8・20「名前照合 /
LCS を daemon に複製しない」と同じ向き）。daemon にとって UI の宛先は `(child, index)` が
すべてで、意味づけは TS が open 時に固定した session エントリが担う。

**このキー写像が成立する条件**が「open 中 UI の index が変わらないこと」である。child は
APPLY の keep シフトで index を動かせる（`set_index`・F の `lib.rs:730`）ため、放置すると
「event は新 index・daemon route と TS session は旧 index」の不整合窓が生まれる（詳細
§4.8）。v1 は **「index がシフト/消滅する stage の open UI は APPLY 前に TS が close する」**
不変条件でこの窓を構造的に閉じる（§4.8・却下した代替は §3 R4/R5）。この不変条件の下では
§3.4-(5) 旧案の「close/save 時に現在のチェーンから index を導出」は不要になる — open 時の
index がそのまま生きているため。

---

## 3. 採用する機構と却下案

### 採用: pump 状態の per-index map 化 + 単一 pending + 共有 arg codec + index 安定性不変条件

構成要素は 4 つ。(a) `UiPumpState` を「child 単位の generation + 単一 pending + per-index
lifecycle/abandoned map」に再構成（§4.1-4.4）。(b) engine_wrap の route を per-index
registry に一般化（§4.5）。(c) event arg の encode/decode を `orbit-audio-sandbox` の共有
関数に対にして置く（§4.3）。(d) 「open 中 UI の index 不変」不変条件と 2 層防衛（§4.8）。

### 却下案

| # | 案 | 却下理由 |
|---|---|---|
| R1 | v1 は 1 child 1 UI に制限（案 B） | owner 確定の DSL 表面（SC.10.10.1 規範 2-3「全部開く」）を後退させる。**owner 判断 2026-08-28 で不採択済み**（ブリーフ §2）。記録のみ |
| R2 | generation を per-index 化 | §2 Q1。1 つの事実（ring 世代）の N 重複製 = 乖離可能な状態を自分で増やす |
| R3 | `pending_safepoint` を per-index map 化 | F3 により pending は構造的に高々 1。map にすると「複数 pending が併存しうる」と型が偽り、読む者に存在しない並行性を防御させる。単一 `Option<PendingSafepoint>`（index 内包）が実態に正直 |
| R4 | event の index を「open 時 index（birth index）」に固定し `set_index` を廃止 | シフト後の再 open で衝突する: stage A が birth 1 のまま open 中に、APPLY 後の現在 index 1 に別 stage B が来て open されると、キー 1 が二重予約になり `begin_open` が**別ウィンドウを理由に**拒否 → TS 冪等層が「もう開いている」と誤飲して **B の UI が silent に開かない**。silent 失敗を作る案は不採 |
| R5 | APPLY commit を ring 上のマーカー event にして daemon の index remap を ring 順序で行う | 機構としては健全（remap と event の順序が ring で全順序化される）が、新 EVT 種別 + daemon 側 remap 簿記 + child 変更が要る。§4.8 の不変条件が成立すれば remap 自体が不要になるため、v1 では過剰。follow-up 候補として記録 |
| R6 | daemon 独自 timeout でリング先頭を放棄 | 既存契約違反: 「child の 10 秒 close timeout より前に daemon 独自の timeout を設けない。脱出は child が publish した事実だけを根拠にする」（`transport.rs:1293-1294` の契約コメント） |
| R7 | `orbit-audio-sandbox` に serde_json を追加して arg を parse | 依存隔離ポリシー違反（F9: lib は memmap2 のみ・fault 隔離の設計意図が Cargo.toml に明記）。arg は child が `format!` で書く 2 形しかない固定文法なので、手書きの厳密 parser が正直（§4.3） |
| R8 | 冪等 open を pump に実装（begin_open が Open で Ok を返す） | PH.2c の「MCP は冪等にしない」が満たせなくなる（§2 Q4）。経路知識を持たない層に経路依存の意味論を置かない |

---

## 4. 詳細設計

### 4.1 データ構造（`orbit-audio-sandbox/src/transport.rs`）

```rust
/// UI の宛先 index。None = 非 indexed（instrument / 旧単発 effect child）。
/// rack child は Some(stage index)。
pub type UiIndexKey = Option<u32>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingSafepoint {
    index: UiIndexKey,
    evt_seq: u64,
}

#[derive(Debug)]
struct UiIndexState {
    lifecycle: UiLifecycle,          // 既存 enum（transport.rs:1241-1247）を流用
    /// この index で timeout 放棄した safepoint。遅着 ack を warn 受理するため保持。
    abandoned_safepoint: Option<u64>,
}

#[derive(Debug, Default)]
struct UiPumpState {
    /// child 単位。respawn reset でのみ増える（§2 Q1）。
    generation: u64,
    /// child 全体で高々 1（ring 先頭直列化・F3）。index を内包する（§2 Q2）。
    pending_safepoint: Option<PendingSafepoint>,
    /// index ごとの lifecycle と放棄水位。エントリは
    /// lifecycle == Closed && abandoned_safepoint == None で除去する。
    indices: BTreeMap<UiIndexKey, UiIndexState>,
}
```

- `BTreeMap` を選ぶ（`HashMap` でなく）: reset 時の `closed_indices` 列挙・ログ・テストの
  出力が決定的になる。エントリ数はチェーン長オーダーで性能差は無意味。
- `Option<u32>` の `None` キーが現行の単一 state と同値に振る舞う（1 エントリしか
  作られない）ため、**instrument / 旧単発 child の観測挙動は変わらない**（完了条件 6）。

### 4.2 状態機械と不変条件

**per-index lifecycle**（既存 `UiLifecycle` の遷移を index ごとに独立化）:

```
Closed --begin_open(i)--> Opening --finish_open(i, true)--> Open
                          Opening --finish_open(i, false)--> Closed
Open   --poll: EVT_UI_CLOSED{i}--> Closing
Closing --poll: EVT_UI_CLOSED_DONE{i}--> Closed
（任意状態） --reset_after_child_exit--> エントリ消滅（= Closed）
```

**不変条件**（実装のコメント・テストで pin する）:

1. **G1**: `generation` は child 単位。増分点は `reset_after_child_exit` のみ（pump lock 内）。
2. **G2**: `pending_safepoint` は高々 1。根拠は ring 先頭直列化（F3）。`poll_step` が
   safepoint で先頭停止する構造を変える変更は、この不変条件の再設計を伴う。
3. **G3**: ack が前進する条件は
   `generation 一致 ∧ pending == Some((index, evt_seq)) ∧ ack + 1 == evt_seq ∧ evt_seq <= published`
   （現行 F5 に index 一致を追加）。ただし per-index の遅着放棄受理
   （`indices[i].abandoned_safepoint == Some(evt_seq) ∧ ring ack >= evt_seq`）が先行する。
4. **G4**: `begin_open(i)` は `indices[i]`（不在 = Closed）が `Closed` のときのみ成功。
   他 index の状態を参照しない。
5. **G5**: エントリ除去は `Closed ∧ abandoned == None` のときのみ。放棄水位は index の
   close 完了後も遅着 ack まで生存する（F7 の per-index 版）。
6. **G6**: リング先頭で停止した `EVT_UI_CLOSED{i}` の放棄エスケープは、**直後のイベントが
   同 index の `EVT_UI_CLOSED_DONE{i, timeout-without-save}` である場合のみ**成立する
   （現行 `is_abandon_done_published` に index 一致を追加。§4.6-(2) の child 側順序保証と対）。

### 4.3 event arg の encode / decode（共有 codec）

**置き場所**: `orbit-audio-sandbox/src/transport.rs`（serde 不使用・手書き）。
child（`orbit-child-runtime`）は既に本 crate に依存している（`ui_service.rs:7-13` の import）
ので、`ui_service.rs:101-118` の `event_arg` をこの共有関数の呼び出しに置き換える
（child 変更 §4.6-(1)）。

```rust
/// EVT_UI_CLOSED の arg。index なし → ""、あり → {"index":n}
pub fn encode_ui_closed_arg(index: UiIndexKey) -> String;
/// EVT_UI_CLOSED_DONE の arg。index なし → completion 素文字列、
/// あり → {"index":n,"completion":"…"}
pub fn encode_ui_closed_done_arg(index: UiIndexKey, completion: UiCloseCompletion) -> String;

/// 逆関数。child が書く 2 形の固定文法だけを受理し、それ以外は Err（loud）。
pub fn decode_ui_closed_arg(arg: Option<&str>) -> Result<UiIndexKey, String>;
pub fn decode_ui_closed_done_arg(arg: Option<&str>)
    -> Result<(UiIndexKey, UiCloseCompletion), String>;
```

- decode は**厳密一致の固定文法**（前置 `{"index":` + 10 進 u32 + …）。汎用 JSON parser を
  書かない。受理できない arg は現行どおり Protocol error（silent fallback しない）。
- encode/decode を同居させ、**round-trip property test を同 mod に置く**（P14）。
  「child の書式と daemon の読解が別 crate で乖離する」という今回の事故類型（設計と実装の
  乖離）を、型と同居テストで構造的に塞ぐ。

### 4.4 `UiEventPump` 各メソッドの変更（transport.rs）

- **`begin_open(&self, index: UiIndexKey)`**（`:1326`）: G4。拒否文言は
  `OPEN_UI requested while lifecycle is {:?} (index {:?})` の形 — **`lifecycle is {:?}` の
  並びを現行から変えない**（F14 の TS アンカー保全・P10 で pin）。
- **`finish_open(&self, index: UiIndexKey, succeeded: bool)`**（`:1341`）: 当該エントリが
  `Opening` のときのみ `Open` / `Closed`（Closed ならエントリ除去）。
- **`poll_step`**（`:1357`）:
  - `EVT_UI_CLOSED`: `decode_ui_closed_arg` で index を得て（現行は arg を読んでいない・
    F20 — ここが新規）、`indices[i].lifecycle = Closing`（エントリ不在なら作る — 追跡外の
    close は現行同様 permissive に受けて通知まで流す）。放棄検査は
    `is_abandon_done_published` に **index 一致を追加**（G6）。通知は
    `UiPumpNotification::Safepoint { generation, evt_seq, index }`。sink false 時の再試行
    dedupe は `pending_safepoint != Some(PendingSafepoint{index, evt_seq})` 比較（現行
    `:1387` と同型）。
  - `EVT_UI_CLOSED_DONE`: `decode_ui_closed_done_arg` で `(index, completion)`。通知は
    `CloseDone { completion, index }`。sink 成功で `indices[i].lifecycle = Closed`
    （G5 に従いエントリ除去判定）。
- **`ack_safepoint(&self, generation: u64, index: UiIndexKey, evt_seq: u64)`**（`:1432`）:
  G3。遅着放棄の warn 受理（`:1446-1453`）は `indices[i].abandoned_safepoint` に対して行い、
  受理後 `None` に戻して G5 のエントリ除去判定。
- **`reset_after_child_exit`**（`:1473`）: pending があれば現行どおり error ログ。
  `closed_indices: Vec<UiIndexKey>` = 非 Closed の全キー（BTreeMap 順）。map 全消去・
  generation 増分・`UiPumpResetOutcome { closed_indices, generation }` を返す。
  lock 順序 **pump → mailbox** は不変（`:1278`・`:1489` の契約）。
- **`final_drain`**（`:1504`）: poll_step と同じ decode。safepoint は現行どおり error ログ +
  当該 index の `abandoned_safepoint` に記録して ack（`:1520-1546`・記録は `:1532` の
  per-index 版）。
  終了時、全エントリを `Closed` 化。
- **`UiPumpNotification`**（`:1189`）: `Safepoint { generation, evt_seq, index: UiIndexKey }` /
  `CloseDone { completion, index: UiIndexKey }`。

### 4.5 engine_wrap.rs / respawn guard の変更

- **route を per-index registry に**: `PluginUiWiring.target`（`:2797-2801`）を
  `Arc<Mutex<BTreeMap<UiIndexKey, PluginUiTarget>>>` へ。型 alias `PluginUiHandles`
  （`:7463`）も追随。
- **`enqueue_plugin_ui_notification`**（`:2810-2863`）: 通知の `index` で registry を引く。
  `Safepoint` → clone・`CloseDone` → remove（現行の clone/take の per-index 版）。
  エントリ不在は現行の「相関する UI 要求なし → 消費」の意味論を維持（warn ログは index 付き）。
  `try_lock` / 非ブロッキング / Poisoned 回復の構造は**変えない**（sink 契約
  `transport.rs:1289-1292`）。
- **`enqueue_plugin_ui_closed_by_respawn`**（`:2865-2880`）: registry の**全エントリを
  drain** し、各 target で `ClosedByRespawn` を配送。配送の実体は registry を典拠とし、
  `UiPumpResetOutcome.closed_indices` は突合ログ（不一致は error ログ — pump と route の
  簿記乖離の検出器）に使う。
- **`open_outproc_plugin_ui`**（`:5634`）: `pump.begin_open(key)` → registry insert（同
  index の旧エントリは上書き）→ `issue_open_ui_at` / `issue_open_ui` → `finish_open(key,
  ok)`。失敗時の registry rollback は現行（`:5678-5684`）の per-index 版。
  `key = rack_target.then(|| index as u32)`（`ui_handles` の bool・`:7342-7359` が判定源）。
- **`close_outproc_plugin_ui`**（`:5690`）: route 照合を registry の当該 index エントリに
  対して行う（現行の単一比較 `:5700-5708` の per-index 版）。
- **`ack_outproc_ui_safepoint`**（`:5721`）: route 照合を per-index にし、
  `pump.ack_safepoint(generation, key, evt_seq)` に index を**渡す**（現行は落としている・
  §0.1）。「DONE 後の遅着 ack は route 不在でも pump へ通す」現行意味論（`:5745-5756`）は
  per-index でそのまま維持。
- **`outproc_respawn_guard.rs`**（`:36-89`）: シグネチャを registry 型に追随。
  ロジック構造は不変。
- **instrument 経路**（`outproc_instrument.rs:494-529` ほか）: 全呼び出しが `None` キーを
  渡すだけ。観測挙動は不変（完了条件 6）。

### 4.6 child 側への提案変更（ブリーフ §3.3 の「変更が必要なら理由を明記」条項に基づく）

**(1) arg encode の共有化**（小・機械的）: `ui_service.rs:101-118` の `event_arg` を
§4.3 の共有 encode 関数呼び出しへ置換。理由: 書式の真実を 1 箇所にし、encode/decode の
乖離（今回の事故類型）を round-trip テストで恒久に封じる。挙動変更なし。

**(2) 🔴 `UiEventHub` に close-cycle 順序ゲートを追加**（必須・机上解析 U2）:

**問題**: 現行 hub は close cycle を跨ぐ publish 順序を守らない（F13）。2 枚の UI が
ともに close に入り、engine が ack を返せない状況（エディタ未接続等）で次の進行が起こる:

1. `UI_CLOSED{i}` が seq `s` で publish → daemon が safepoint 通知 → ack 待ちで先頭停止
2. hub は続けて `UI_CLOSED{j}` を `s+1` に publish（F2: `evt_ack >= s-1` なので載る）
3. index i が 10 秒 timeout → Phase B（F12）→ `UI_CLOSED_DONE{i, timeout}` を publish
   しようとするが、`s+2` は `evt_ack >= s` が要る（F2）— **先頭 `s` が未 ack なので載らない**
4. daemon の放棄エスケープ（`is_abandon_done_published`）は **`s+1` に DONE がある場合のみ**
   成立する（`transport.rs:1576-1585`）。`s+1` は `UI_CLOSED{j}` — 成立しない
5. → **リング先頭が永久に詰まる**。以後この child の UI は open 不能（F11 の drain ゲート）。
   respawn まで回復しない

`EVT_SLOTS = 2` の導出は「**1 つの close cycle** の占有上限 = 2」（`transport.rs:83-103` の
注記）であり、cycle が interleave しない前提が暗黙にあった。多重ウィンドウはこの前提を
破る。**pump 側だけでは直せない**（R6: daemon timeout は契約違反・イベントは既に ring に
入ってしまっている）ため、child hub に次のゲートを足す:

> `UI_CLOSED{x}` を ring に載せたら、その cycle の `UI_CLOSED_DONE{x}` を載せるまで、
> 他イベントを ring に載せない（hub 内 `open_cycle: Option<UiIndexKey>` で追跡。
> 他 index の close event は `pending` deque で待たせる）

- 待たされた index j 側の状態機械は無変更で耐える: `ui_closed_seq` が `None` のまま
  timeout に達した場合の遅延 publish 経路（`pending_ui_closed` / Closed 状態からの
  `try_publish_close_events`・`orbit-child-ui/src/lib.rs:300-320`）が既にある（F12）
- 副作用: j の close が i の cycle 完了まで直列待ちになる。正常系（engine が ack を返す）
  では cycle は秒未満で完了し体感差なし。異常系では j が timeout-without-save に倒れうるが、
  **有界・loud**（現行の単一 UI と同じ最悪値）であり、永久詰まりとは比較にならない
- この保証があって初めて G6（同 index DONE によるエスケープ）が健全になる

### 4.7 TS 側の変更

- **(1) wire の `chain_path` 送出**（F16 の穴埋め・必須）: `daemon-client.ts` の
  `openPluginUi` / `acceptClosePluginUi` / `ackUiSafepoint`（`:546-575`）に
  `chain_path: [index]` を追加する。現状 TS は `index` フィールドを送るが daemon は
  `chain_path`（省略時 0）しか読まないため、**index ≠ 0 の UI 操作は wire 層で 0 に
  化けている**。per-index 化の前提整備。
- **(2) `ui("名前")` fan-out**: 実装設計書 §3.4-(8) のまま（本書は変更しない）。複数一致の
  各 index へ `openPluginUiIdempotent` を発行。
- **(3) session 簿記**: **キー変更なし**（§2 Q5）。§3.4-(5) 旧案の instanceId キー化と
  「close/save 時の index 導出」は撤回。
- **(4) APPLY 前の close 義務**（§4.8 の S1）: `applyRack` は plan 確定後・wire 発行前に、
  open session のうち **(a) drop 対象 (b) 同位置 replace 対象 (c) keep だが
  `prev_index != new_index`** の各 UI を `closePluginUi` で閉じ、safepoint 保存を完了させて
  から `ApplyEffectChain` を発行する（#625 の「保存 → close → APPLY」順序 R15 の一般化）。
  (a)(b) は実装設計書 §3.4-(5) が既に要求。**(c) が本書の追加**。

### 4.8 index 安定性の不変条件と 2 層防衛

**不変条件 I**: *open 中の UI が指す stage の index は、その UI が閉じるまで変わらない。*

これが必要な理由（すべて実コードから）: child は APPLY commit で keep stage の index を
書き換え（`lib.rs:730` `set_index`）、以後の close event は**新 index** を運ぶ。一方 daemon
route / TS session は open 時 index のまま。remap を挟む案は、remap（TS/daemon 側の時刻）と
event（ring 上の時刻）の間に全順序がなく、APPLY 進行中（プラグイン load で秒単位）に
ユーザーがウィンドウを閉じると**別 stage への誤帰属**（保存 identity の取り違え — #601 I1 が
まさに禁じた事故）が起きうる（順序付け可能な R5 は v1 過剰として却下）。

**防衛 1（TS・一次）**: §4.7-(4)。plan を作った層が plan を知っているので、シフトの判定は
LCS 結果（keep の `prev_index` ↔ 新位置）から機械的に出る。

**防衛 2（daemon・TS バグの loud 化）**: `ApplyEffectChain` の daemon ハンドラは、適用前に
pump の open index 集合（`indices` の非 Closed キー）と plan を突合し、**drop / replace /
シフト keep の対象 index に open UI が残っていたら APPLY を確定拒否**する（文言例:
`stage <i> has an open plugin UI; close it before applying a chain edit that moves or removes it`）。
retain-on-reject（実装設計書 決定 11）なので旧チェーンは無傷・楽譜の再評価で復旧できる。
これにより防衛 1 の欠落（TS バグ）は silent 誤帰属ではなく loud な拒否として現れる。

**残余リスク**: 防衛 2 の判定とユーザーの close click は並行しうる（判定時 Open →
直後に Closing）。この場合も index は APPLY 拒否により動かないので誤帰属は起きない —
拒否が 1 回多く出るだけ（再評価で解消）。逆向き（判定時 Closing → 拒否）も同様に安全側。

---

## 5. 失敗モード一覧 ↔ 受け入れ基準テスト（1:1 対応表）

置き場: P\* = `orbit-audio-sandbox/src/transport.rs` の `mod tests`（既存 fixture
`TestRegion` 方式・`:2148` 以降と同居）、W\* = `engine_wrap.rs`
`plugin_ui_event_routing_tests`（`:7838` 以降）ほか daemon unit、H\* =
`orbit-child-runtime/src/ui_service.rs` の `mod tests`（C15・`:1083` の隣）、S\* = TS
（`tests/core/` の既存 plugin-ui spec / `effect-rack.spec.ts`）。E2E は実装設計書 §6 の
gated 枠に 1 シナリオ追加。**テストの無い失敗モード、対応する失敗モードの無いテストは
無い。** 変異は 4 種（分岐反転 / 回数 / 順序 / 引数）を表全体で横断している。

| # | 失敗モード | 検出するテスト | 変異（red の確認方法） |
|---|---|---|---|
| P1 | 2 index 同時 open が拒否される（本丸の退行） | `begin_open(Some(0))` → `begin_open(Some(2))` 双方 Ok・`finish_open` 後どちらも Open | per-index map を単一 lifecycle に戻す → red |
| P2 | 同 index 再 open が silent 二重予約になる | `begin_open(Some(0))` 成功後、再度 `begin_open(Some(0))` → Protocol error・pending/lifecycle 不変 | G4 の lifecycle 検査を削除 → red |
| P3 | 別 index の ack が pending を消す（取り違え） | pending = (Some(2), s) の状態で `ack_safepoint(gen, Some(0), s)` → Protocol error・pending 残存。正しい `(gen, Some(2), s)` で前進 | ack の index 照合を削除 → red（引数変異） |
| P4 | 旧世代 ack の受理（既存保全の退行） | respawn reset 後に旧 generation で ack → `GenerationMismatch` | generation 照合を削除 → red |
| P5 | safepoint 通知の index 落ち / 誤配送 | `EVT_UI_CLOSED` arg `{"index":2}` を poll → 通知 `Safepoint{index: Some(2)}` | decode を常に None に固定 → red（引数変異） |
| P6 | indexed DONE arg が Protocol error（**現行の実バグ**・§0.1） | arg `{"index":1,"completion":"safepoint-completed"}` を poll → `CloseDone{index: Some(1), SafepointCompleted}`・ring 前進 | 旧・完全一致 parse に戻す → red |
| P7 | 非 indexed arg の退行（instrument 経路） | 空 arg の `UI_CLOSED` / 素文字列 DONE → `index: None` で従来どおり完走（既存テスト + None 明示 assert） | decode が None 形を Err に → red |
| P8 | respawn reset が open index を取りこぼす | indices = {0: Open, 2: Closing} で reset → `closed_indices == [Some(0), Some(2)]`・map 空・generation +1 | 列挙を最初の 1 件で打ち切り → red（回数変異） |
| P9 | 放棄水位の上書き（別 index の放棄が先行放棄を消す） | index 0 放棄(s0) → index 2 放棄(s2) → 両方の遅着 ack が warn 受理される（`ack_safepoint` 2 回とも Ok） | per-index abandoned を単一 Option に戻す → red（1 件目の ack が Protocol error） |
| P10 | begin_open 拒否文言のアンカー崩れ（TS 冪等層との結合・F14） | 拒否 message が `"OPEN_UI requested while lifecycle is Open"` を**部分文字列として含む**ことを rust unit で pin | 文言の語順変更（index を lifecycle の前に挿入）→ red |
| P11 | 別 index の DONE で放棄エスケープが成立してしまう | 先頭 `UI_CLOSED{0}`・次 slot に `DONE{2, timeout}` → エスケープ**しない**（先頭保持）。次 slot が `DONE{0, timeout}` ならエスケープする | `is_abandon_done_published` の index 照合を削除 → red |
| P12 | エントリ削除が早すぎて遅着 ack 経路が消える（G5） | DONE 完了（Closed）だが abandoned 有りの index → エントリ生存 → 遅着 ack warn 受理 → エントリ消滅 | Closed で即削除に変える → red（順序変異） |
| P13 | pending の再通知 dedupe 退行 | sink が 1 回目 false → 2 回目 true の fixture で、Safepoint 通知が**ちょうど 2 回**・pending は 1 つ | dedupe 比較から index を落とし常に再通知 → red（`toHaveBeenCalledTimes` 相当の回数 assert） |
| P14 | encode/decode の乖離（crate 間の書式ずれ） | 全 `(UiIndexKey, completion)` 組の round-trip property（encode → decode == 恒等） | encode 側の JSON キー名を変える → red |
| W1 | route registry の誤配送（CloseDone が全エントリを消す） | registry = {0: t0, 2: t2} で `CloseDone{index:2}` → t2 のみ remove・t0 残存・event target == t2 | remove を clear に変える → red（回数変異） |
| W2 | Safepoint 配送先の取り違え | `Safepoint{index:0}` → 配送 event の target == t0（t2 でない） | lookup を「最初のエントリ」に固定 → red（引数変異） |
| W3 | respawn の ClosedByRespawn が 1 件しか出ない | registry 2 件で respawn → `ClosedByRespawn` が**ちょうど 2 通**・target 集合一致 | drain を 1 件で打ち切り → red |
| W4 | ack 経路が index を pump へ渡さない（§0.1 の現行欠落の再発） | `ack_outproc_ui_safepoint(…, index=2, …)` が `pump.ack_safepoint` に Some(2) を渡す（fixture pump で引数捕捉） | 渡す index を常に None に → red（引数変異） |
| W5 | APPLY が open UI のシフトを黙って通す（§4.8 防衛 2） | open index 2・plan = 先頭 drop（2→1 シフト）→ ApplyEffectChain が確定拒否・文言に stage index | 突合検査を削除 → red |
| W6 | 防衛 2 が安定 keep まで拒否する（過剰阻止 = live-coding 破壊） | open index 0・plan = 末尾 append（シフトなし）→ APPLY 成功 | 突合を「open UI があれば常に拒否」に反転 → red（分岐反転） |
| H1 | close-cycle 順序ゲートの不在（§4.6-(2) デッドロックの入口） | UI i close 開始（`UI_CLOSED{i}` publish 済・未 ack）→ UI j close 要求 → ring に `UI_CLOSED{j}` が**載らない**（seq が増えない）。i の DONE 後に j が載る | ゲート削除 → red（`UI_CLOSED{j}` が s+1 に載る） |
| H2 | 放棄エスケープの永久詰まり（統合・U2 の実証） | fixture ring で: i close → ack 停止 → j close → i timeout。`DONE{i,timeout}` が s+1 に載り、daemon 側 poll（P 系 fixture）が先頭を放棄できる | H1 ゲート削除 → red（先頭が進まない） |
| H3 | 他 index close 進行中の open 拒否契約（F11 の明文化） | i の close cycle 中に j へ `CMD_OPEN_UI` → `CLOSING_IN_PROGRESS`（open しない）。cycle 完了後は open 成功 | drain 判定を恒真に → red |
| S1 | APPLY 前 close の対象漏れ（シフト keep を閉じ忘れ） | plan がシフト keep を含み open session あり → `closePluginUi` が**先に**呼ばれてから wire 発行（呼び出し順 assert） | 判定を drop/replace のみに絞る → red（分岐変異）/ close と APPLY の順序を逆転 → red（順序変異） |
| S2 | chain_path 未送出（F16 の穴・index が wire で 0 に化ける） | `daemon-client` unit: `ackUiSafepoint(…, index=2, …)` の request payload に `chain_path: [2]` | chain_path 付与を削除 → red |
| S3 | 複数 close event の index 別 settle 取り違え | pending close 2 件（index 0, 2）で `CloseDone{index:2}` → index 2 の promise のみ settle（既存 `settlePendingPluginUiCloses` の per-index 実証） | target 照合から index を落とす → red |
| E2E | 同名 2 insert の全開き（SC.10.10.1 規範 2-3・完了条件 2） | gated: rack `[A, A]` 宣言 → `ui("A")` → 2 ウィンドウ生存を MCP 経由で確認 → 片方 close → state 保存 → 再評価で冪等（エラーなし） | （E2E は変異対象外・実装設計書 §6 の規約に従う） |

**変異 4 種の横断確認**: 分岐反転 = P2/W6/H3・回数 = P8/P13/W1/W3・順序 = P12/S1・
引数 = P3/P5/W2/W4/S3。

---

## 6. 触ってはいけないもの

1. **quiesce / `shutdown` latch / `clear_quiesce_unless_shutdown` の SeqCst 指定**（#625 が
   潰した UB レースの再導入禁止・ブリーフ §3.3）。本設計はこれらに一切触れない。
2. **RT コード**: `orbit-audio-native` / `OutProcEffectPostProcessor::process`。UI pump は
   watchdog スレッドの持ち物であり、audio callback 側に分岐を足さない。
3. **`chain_path`（0 始まり整数配列・v1 長さ 1）の wire 表現**（確定済み）。本設計は
   その配列の**送出**を TS に足すだけで、形は変えない。
4. **audio シーケンスの `play()` 意味論**（プロジェクト規則 5）。
5. **`EVT_SLOTS = 2` とその導出**（`transport.rs:83-103`）。§4.6-(2) のゲートは
   「1 cycle 占有 ≤ 2」の前提を**回復する**ための変更であり、slot 数は変えない。
6. **lock 順序 pump → mailbox**（`transport.rs:1278`・`:1489`）と sink の非ブロッキング契約
   （`transport.rs:1289-1292`）。
7. **child の 10 秒 close timeout より前の daemon 独自 timeout の新設禁止**
   （`transport.rs:1293-1294`）。
8. **`EventRingHost` の poll-gate CAS**（raw poll 同時実行の fail-loud 検出・
   `transport.rs:1297-1298`）。
9. **mailbox の generation 機構**（`transport.rs:866-905`）— UI pump の generation とは別物。
   触らない。
10. **instrument 経路の観測挙動**（完了条件 6）。`UiService::new`（非 indexed）の意味論・
    instrument child の binary は無変更。
11. **`openPluginUiIdempotent` の 2 アンカー方式**（F14）— 本設計は文言互換（P10）で守る側。
    TS 側の判定ロジック自体は変えない。

---

## 7. 確信度が低い決定と反証方法

🔴 実コードで確認した項目（§0.3 の F1-F20・行番号つき）と、推論で置いた項目を区別する。
以下は**推論を含む**決定。

| # | 決定 | 確信度 | 推論部分 | 反証方法 |
|---|---|---|---|---|
| 1 | §4.6-(2) の ring デッドロックは実在する | 中〜高 | F2/F3/F12/F13/`transport.rs:1576-1585` からの**机上組み立て**。実測していない | **実装の最初に H2 の再現 fixture を書く**（`TestRegion` + 2 UiService + ack 停止）。再現しなければゲートは防御実装へ格下げし、その事実を本書に追記する。再現テスト自体は残す |
| 2 | 不変条件 I（open UI の index 不変）は live-coding ワークフローを実害レベルで阻害しない | 中 | 「シフトを伴う編集は稀・末尾 append が常態」は**利用実態の推定**。シフト時に UI が強制 close され再 open されない挙動はユーザー可視 | 🔴 **owner 確認事項**: 「open 中の UI がある stage より前を drop/insert すると、その UI は保存つきで自動 close される（自動 re-open はしない）」を v1 挙動として受容するか。DSL 文法ではないが UX 表面（`mem:ux-surface-before-mechanism` / `mem:dsl-surface-needs-owner-confirmation` の趣旨）。不受容なら R5（ring マーカー remap）を v1.1 で設計する |
| 3 | 待たされた close の timeout-without-save 化（§4.6-(2) 副作用）は受容可能 | 中〜高 | 発生条件（engine ack 不能 + 多重 close）の希少性は推定。ただし有界・loud で、現行単一 UI の最悪値と同じ | H2 fixture で副作用の発生条件を実証し、gated E2E（正常系）で非発生を確認 |
| 4 | `Option<u32>` キーで instrument 経路が無変更に保てる | 高（コード確認済み） | 「`ui_handles` の bool が唯一の分岐源」は `engine_wrap.rs:7342-7359` で確認。ただし全 call site の網羅は grep ベース | 完了条件 6（既存テスト無修正 green）が反証装置そのもの |
| 5 | TS の message アンカーは P10 の語順維持で守れる | 高 | `includes` の 2 アンカー（F14）は確認済み。ただし TS 側に**他の**文言依存が無いことは grep（`OPEN_UI requested` / `already-open`）の範囲 | 実装時に `rg "lifecycle is" packages/` を回し、依存箇所を P10 のテスト対象に全列挙する |
| 6 | 防衛 2（daemon 突合拒否）が APPLY の正常系を阻害しない | 中〜高 | 「安定 keep は拒否対象外」のロジックは plan 形式（実装設計書 §3.1-(5) の `prev_index`）からの導出で、plan 実装は本ブランチで進行中 = 動く実物での確認は未 | W5/W6 の対で両側を pin。実装フェーズで plan 実物に対して回す |
| 7 | 非 rack effect child の存続有無に設計が依存しない | 高 | U1。`None` キーの縮退で吸収 | 実装時に effect 経路の `ui_handles` 呼び出しの `rack_target` 値を確認し、`false` が残る経路があれば P7 相当の unit を effect 側にも複製 |

---

## 8. 実装順序（Codex 委譲の分割単位）

1. **transport.rs**: §4.3 codec + §4.1/4.4 の per-index 化 + P1-P14（H2 の再現 fixture を
   最初に書く — 確信度 #1 の反証を先に済ませる）
2. **child**: §4.6-(1) encode 共有化 + §4.6-(2) 順序ゲート + H1-H3
3. **engine_wrap / respawn guard**: §4.5 + W1-W6
4. **TS**: §4.7 (1)(4) + S1-S3
5. **gated E2E**: 完了条件 1・2 のシナリオ
6. 各段で `npm test` / `cargo test` 全 green + 変異実証を報告に含める（プロジェクト規則）

検証（sandbox 外の実機 E2E）は main の担当（CLAUDE.md 工程表）。
