> 🗄️ **アーカイブ（2026-09-03・#696）。** 本文書は記録として残すが、**現在の正本ではない**。
> **現在の正本**: **#633 CLOSED**（出荷済み・PR #652）/ 現在地は `DEVELOPMENT_MAP.md` §4.B・§4.C
>
> 内容は移動時のまま。**新しい判断の根拠にしないこと**（[[check-the-date-before-trusting-a-doc]]）。

# 設計書: `UiEventPump` の多重ウィンドウ化 — 位置指定から window token へ（issue #628・owner 決定 A・改訂 2）

> 起案: Fable subagent（2026-08-28）。改訂 2（同日）: owner 原則による差し戻しを受けた
> 全面改訂（経緯は §0.5）。実装は含まない。
> 本書は `docs/archive/design/628-rack-chain-implementation-design.md`（以下「実装設計書」）の
> **§3.1-(6) の 2 番目の bullet・§3.4-(5)・決定表 #12 を置き換える**。差し替えの明細は §0.2。
>
> 🔴 本書の前提事実はすべて実ファイルで確認し、ファイル名と行番号を添えた。
> 確認していない項目は §0.4 に「未確認」として隔離した。「自然対応する」の類の
> 未検証前提は書いていない。

---

## 0. 対象と経緯

### 0.1 何が壊れているか（実コードで確認済み）

child 側は多重ウィンドウ化済み・daemon 側が単一 lifecycle のまま、という非対称がある。

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
  された stage は防御的に close され（`lib.rs:733-736`）、`pending_stage_drops` に退避されて
  close cycle 完了まで tick され続ける（`lib.rs:474`・`lib.rs:782-789` `tick_ui`）

**daemon 側（未対応・本設計の対象）**:

- `orbit-audio-sandbox/src/transport.rs:1249-1256` — `UiPumpState` は
  `generation` / `pending_safepoint` / `abandoned_safepoint` / `lifecycle` を**各 1 つ**持つ
- `transport.rs:1326-1339` — `begin_open()` は `lifecycle != Closed` を loud に拒否
  = **1 child につき UI 1 枚**
- `transport.rs:1395-1409` — `poll_step` の `EVT_UI_CLOSED_DONE` 腕は arg を
  `"safepoint-completed"` / `"timeout-without-save"` の**完全一致**でしか受理しない。
  rack child の indexed arg は Protocol error になり、**イベントが ack されないまま
  リング先頭が永久に詰まる**。つまり現状は「2 枚目が開けない」だけでなく、
  **rack child の 1 枚目の close も完走しない**（main が実コードで裏取り済み）
- `transport.rs:1576-1585` — `is_abandon_done_published` も arg 完全一致
  （`Some("timeout-without-save")`）なので、rack child では timeout 放棄エスケープも壊れる
- `orbit-audio-daemon/src/engine_wrap.rs:2797-2801` — `PluginUiWiring.target` は
  `Arc<Mutex<Option<PluginUiTarget>>>`（**単一 route**）。`engine_wrap.rs:2810-2863`
  `enqueue_plugin_ui_notification` は Safepoint で clone・CloseDone で take する
- `engine_wrap.rs:5634-5686` `open_outproc_plugin_ui` は `pump.begin_open()`（宛先なし）→
  route 単一代入 → rack なら `issue_open_ui_at`。`engine_wrap.rs:5721-5764`
  `ack_outproc_ui_safepoint` は wire から index を受け route と照合するが、
  `pump.ack_safepoint(generation, evt_seq)` には**宛先を渡していない**

### 0.2 実装設計書からの差し替え箇所

| 箇所 | 旧記述 | 本書での扱い |
|---|---|---|
| §3.1-(6) bullet 2 後半 | 「daemon の UI pump / TS の session 簿記は instanceId キー（§3.4-(5)）なので多重に自然対応する」 | **削除**。pump は child 単位の単一 state（§0.1）。本書 §4 が正 |
| §3.4-(5) | 「session キーを instanceId へ変え、close/save 時に現在のチェーンから index を導出」 | **改訂**。session は **window token** で引く（§4.7）。「現在のチェーンから index を導出」は close の**宛先**（chain_path）にだけ使い、**帰属**（イベント→session）には使わない。beforeReplace の「drop / replace 対象の open UI を APPLY 前に close する」は**有効のまま** |
| 決定表 #12 | 確信度「高」のまま多重対応を既成事実化 | **置換**。本書 §2-§4 が正。旧 #12 の他の内容（3 起動経路・`chain_path` 宛先）は有効のまま |

### 0.3 実コードで確認した事実の一覧（根拠行番号）

| # | 事実 | 根拠 |
|---|---|---|
| F1 | event ring は child につき 1 本・`evt_seq` は単一カウンタ | `transport.rs:267`（`SharedRegion.evt_seq`）・`transport.rs:83-87`（`EVT_SLOTS = 2`） |
| F2 | ring の publish 容量: seq `s` を publish できるのは `evt_ack >= s - EVT_SLOTS` のとき | `transport.rs:517-531` |
| F3 | `poll_step` は safepoint 通知後 handler が false を返すと**先頭で停止**し、ack されるまで後続イベントを読まない → **pending safepoint は child 全体で高々 1** | `transport.rs:554-575`・`transport.rs:1387-1397` |
| F4 | `generation` の唯一の増分点は `reset_after_child_exit`（respawn 時・child 全体） | `transport.rs:1473-1501`（`wrapping_add` は `:1491`） |
| F5 | ack の in-order head 検査: `ack + 1 == evt_seq && evt_seq <= published` | `transport.rs:1461-1466` |
| F6 | 既存注記「generation は同一世代内の evt_seq 取り違えまでは守らない」 | `transport.rs:1299-1300` |
| F7 | `abandoned_safepoint` は DONE 後（lifecycle Closed 後）も遅着 ack 受理のため生存する | `transport.rs:1252-1254`・`transport.rs:1446-1453` |
| F8 | 類似機構の前例: mailbox の `InFlightCommand.generation` は「seq 単独で現状足りるが、単調性が他所の不変条件に依存するため併記照合する」 | `transport.rs:866-884` |
| F9 | `orbit-audio-sandbox` は依存隔離ポリシーで serde を持たない（lib は memmap2 のみ） | `orbit-audio-sandbox/Cargo.toml`（冒頭コメント + `[dependencies]`） |
| F10 | `EVT_ARG_BYTES = 256` — token 付き DONE arg（後述 §4.3・最大 60 byte 弱）は余裕で収まる | `transport.rs:288-290` |
| F11 | child の open 受理は **hub 全体の drain 検査**を含む（他 window の close cycle 進行中は `CLOSING_IN_PROGRESS` 拒否） | `orbit-child-ui/src/lib.rs:207-225`・`ui_service.rs:176-182`（`is_drained` は hub 全体） |
| F12 | child の close 状態機械: Phase A で `UI_CLOSED` publish → 自 seq の ack か 10 秒 timeout で Phase B（破棄）→ `UI_CLOSED_DONE`。`UI_CLOSED` 未 publish のまま timeout した場合の遅延 publish 経路もある | `orbit-child-ui/src/lib.rs:262-320`・`UI_CLOSE_TIMEOUT` は `ui_service.rs:20` |
| F13 | child hub は close cycle を跨いだ publish 順序ゲートを**持たない**（pending FIFO・`queued_in_ring` は publish 完了で即クリア） | `ui_service.rs:127-171` |
| F14 | TS の DSL 冪等 open は message アンカー `'OPEN_UI requested while lifecycle is Open'` と `'already-open'` に依存する | `packages/engine/src/core/global.ts:996-1030`（`openPluginUiIdempotent`） |
| F15 | TS session 簿記は open 時に identity を確定し再解決しない（#601 I1）。「index を永続キーへ流用しない」と明記されている | `global.ts:125-135`・`global.ts:833-855`・`global.ts:858-860` |
| F16 | wire の AckUiSafepoint / OpenPluginUI は daemon 側で `chain_path`（省略時 0）を読むが、**TS は chain_path を送っていない**（`index` パラメータは daemon に読まれない） | `session.rs:323-345`・`session.rs:1981-2020`・TS 側 grep で `chain_path` 出現 0 件（main が裏取り済み） |
| F17 | daemon → TS のイベントフレームは `PluginUiTarget { role, bus, instance, index }` を運び、TS は `target.index` を echo して ack する | `engine_wrap.rs:7773-7781`・`rust-engine-player.ts:578-599` |
| F18 | respawn 時の UI 整理: `service_ui_pump_on_respawn` → `reset_after_child_exit` → `closed_visible_ui` なら単一 target の `ClosedByRespawn` を配送 | `outproc_respawn_guard.rs:36-57`・`engine_wrap.rs:2865-2880` |
| F19 | TS は respawn クローズ通知で session 簿記を即時破棄する（#619 R2） | `global.ts:216-223`・`rust-engine-player.ts:626-640` |
| F20 | `poll_step` の `EVT_UI_CLOSED` 腕は arg を**読んでいない**。DONE 腕だけが arg を読む | `transport.rs:1366-1414` |
| F21 | mailbox は single-outstanding coordinator（コマンドは child ごとに直列） | `transport.rs:892`（コメント）・`CommandMailboxState.in_flight` は単一 `Option`（`:886-890`） |
| F22 | AckUiSafepoint は wire 上 index 必須ではない（chain_path 省略で 0 に既定） | `session.rs:3475`（テスト名 `ack_ui_safepoint_command_does_not_require_an_index`）・`session.rs:2647-2661` |
| F23 | daemon の close は「requested target == 現 route target」の全等値比較で守っている | `engine_wrap.rs:5697-5708` |
| F24 | ack 経路は `ui_handles(chain_index)` を通り、effect では per-stage の検分（catalog か・範囲内か）まで行う | `engine_wrap.rs:5721-5730`・`:7342-7359`・`validate_effect_chain_target :7449-7461` |

### 0.4 未確認事項（設計はこれらに依存しない形にした）

| # | 項目 | 依存しない理由 |
|---|---|---|
| U1 | #628 完了後に非 rack の effect child（単発 CLAP/VST3 child）が残るか | pump のキーを `Option<u64>` にし、`None` = 非 indexed とすることで、残っても残らなくても同じコードが動く（§4.1） |
| U2 | §4.6-(2) の ring デッドロック（机上解析）が実機で再現するか | 実装前に fixture で再現テストを書く（§7-1）。再現しなければゲートは防御実装に格下げしてよいが、テストは残す |
| U3 | `ORBIT_GATED_ORBITSTUDIO` E2E ハーネスが同一 receiver への同名 2 plugin 配置を既にサポートするか | E2E 行（§5 表末尾）は既存ハーネスの範囲で書く。不足があれば実装フェーズで報告 |
| U4 | `CommandMailboxHost` へ並行に issue した 2 コマンドの後着側の挙動（待つのか loud エラーか） | 本設計はコマンド宛先の最終検分を child 側 token 照合（§4.6-(3)）に置くため、daemon 側の直列化粒度に依存しない |
| U5 | child の防御 close（drop 時）の safepoint 保存が「TS が APPLY 応答待ちの間」に完了できるか（engine 側保存経路の前提条件） | 一次経路は従来どおり「TS が APPLY **前に** drop/replace 対象を save→close」（実装設計書 §3.4-(5)・維持）。防御経路は fallback であり、完了条件に含めない |

### 0.5 🔴 改訂 2 の経緯 — owner 原則による差し戻し（2026-08-28）

改訂 1 は「open 中 UI の index は不変」を不変条件 I とし、**index がシフトする stage の
open UI を TS が APPLY 前に自動 close する**ことで強制していた。owner 確認（§7-2 として
提示）の結果、**不受容**:

> 開いてるのを勝手に閉じたり開いたりするってこと？それなら受容できない。
> **開いてるものはユーザーが閉じるまでそのまま開いてるべきで、閉じてるものは
> ユーザーの違う操作で勝手に開いたりしたらダメ**ですよね？

以後この 2 点は**設計の制約条件**である:

- **C-A: 開いている UI は、ユーザーが閉じるまで開いたままであること**
- **C-B: 閉じている UI が、ユーザーの別の操作で勝手に開かないこと**

不変条件 I とその防衛（TS の APPLY 前 close のシフト keep への拡大 + daemon の突合拒否）は
**廃案**。問題の本質は「**開いているウィンドウを位置（index）で宛先指定・帰属していた**」
ことにある。位置で指す限り、チェーン編集と open UI の共存は「動かさない」（= 自動 close =
C-A 違反）か「追随させる」（remap）しかなく、前者が禁じられた以上、**ウィンドウの帰属は
位置から独立した安定識別子で行う**（本改訂の核・§3）。

**C-A の例外（owner 確定 2026-08-28）**: APPLY で **drop / 同位置 replace された stage の
UI は閉じてよい**。owner の言葉:

> drop された要素の UI は、プラグイン自体が消えるのでウィンドウが残る方が不整合です。
> ここは「対象の消滅」という例外に当たると考えます < **これはそうだな。**

判定の軸は「**位置が変わったか**」ではなく「**対象のインスタンスが生き残ったか**」である:

| 操作 | 挙動（確定） |
|---|---|
| ユーザーが要素を**削除**した（drop / 同位置 replace の旧側） | その要素の UI は**閉じてよい**（対象が消滅した） |
| **別の要素**の追加・削除で open UI の**位置がずれた**（LCS keep） | **開いたまま**でなければならない（対象は生きている） |
| `enabled: false` にした要素（SC.10.2 の状態保持バイパス） | **開いたまま**（§4.8-(5) — インスタンスは生きている） |
| 閉じている UI | ユーザーの**別の操作で勝手に開かない** |

生存 / 消滅の分類は LCS が `applyRack` 時点で確定させる（keep = 生存・drop = 消滅・
実装設計書 §3.4-(2)）ので、そのまま UI の扱いの分類として使う。
child は消滅側の防御 close を既に実装している（`lib.rs:733-736`・退避 tick は
`lib.rs:782-789`）。

---

## 1. 完了条件（曖昧語なし）

1. **同一 rack child 内の 2 つの catalog stage の UI が同時に開く**: `open_outproc_plugin_ui`
   を index 0 と 2 に対して呼ぶと双方 `Ok` を返し、双方のウィンドウ生存中にどちらか一方の
   close（safepoint → ack → DONE）が**他方の lifecycle を変えずに**完走する。
2. **`ui("A")` の複数一致で全部開く**（SC.10.10.1 規範 2-3・`SIGNAL_CHAIN_DSL_SPEC_v1.md:398`）:
   rack `[A, A]` に対する `ui("A")` で 2 枚のウィンドウが開く gated E2E が green。
3. 🔴 **open 中の UI は index シフトをまたいで開いたまま**（C-A）: stage 2 の UI を開いた状態で
   stage 0 を drop する APPLY を適用しても、**その UI へ close コマンドが一切発行されず**
   ウィンドウが生存する。その後のユーザー close は新 index の宛先で届き、保存は
   **open 時に確定した identity** へ行われる（#601 I1）。
4. **indexed arg の受理**: `EVT_UI_CLOSED_DONE` の token 付き arg を
   `poll_step` / `final_drain` / `is_abandon_done_published` が正しく解釈する（§0.1 の
   「1 枚目の close も完走しない」欠陥の解消）。非 indexed の従来 arg も従来どおり受理する。
5. **ack の照合キーは (generation, window, evt_seq)**: 別 window を名乗る ack は loud に
   拒否され、pending は消えない。
6. **respawn reset は開いていた全 window を畳む**: 各 window の `ClosedByRespawn` が TS に
   届き、TS session 簿記の該当エントリが全て消える。
7. **instrument 経路の観測挙動は不変**: instrument の既存ユニット・gated テストが全て
   無修正で green。
8. **同 index への再 open**: DSL 経路では no-op 成功、MCP 直接経路では loud 拒否
   （PH.2c・`INSTRUCTION_ORBITSCORE_DSL.md:1338-1341`）。
9. **§5 の失敗モード表の全行が変異で red → restore で green を実証済み**（変異 4 種横断）。

---

## 2. ブリーフ §3.2 の 5 問への回答（改訂 2）

改訂 1 からの生存状況: Q1 =そのまま。Q2・Q3 = **構造は生存・キーの実体を index から
window token へ置換**。Q4 = そのまま（アンカーの発生源が 1 箇所増える）。Q5 = 書き直し。

| 問 | 決定 |
|---|---|
| Q1 generation の粒度 | **child 単位のまま**。window は照合の別次元として持つ |
| Q2 ack の照合キー | **(generation, window, evt_seq) の三つ組**。pending は `(window, evt_seq)` を保持 |
| Q3 複数 Closing の teardown | lifecycle は per-window map。reset は非 Closed の全 window を列挙して返す。`abandoned_safepoint` は **per-window に 1 つ**（map エントリ内の `Option<u64>`） |
| Q4 begin_open の拒否条件 | **当該 window key の lifecycle != Closed のときのみ loud 拒否**。別 window は無条件に独立。「同じ stage をもう一度開く」の loud 拒否は daemon の binding 検査（§4.5）が担い、同 index 冪等は現行どおり **TS 層** で実現する。pump は冪等化しない |
| Q5 instanceId ↔ daemon 宛先の写像 | **帰属（イベント→session→identity）は window token**・**宛先（コマンド→stage）は chain_path** の 2 レイヤに分離する。写像の持ち主は TS session 簿記（open 時確定・不変）。位置は宛先にだけ現れ、帰属には一切使わない |

### Q1: generation は child 単位のまま（改訂 1 から不変）

generation が守る対象は ring の seq 巻き戻りで、ring は child につき 1 本（F1）。全 window は
同一 ring を共有するので巻き戻りは常に全 window 同時。per-window generation は「1 つの事実
（ring の世代）の N 重複製」であり、複製は乖離しうる — 今回の穴（検証されない前提）と同型の
構造を自分で作ることになる。respawn は child 全体を作り直す（F4）ので「window ごとに世代が
異なる」状況はプロトコル上存在しない。

### Q2: ack の照合キーは (generation, window, evt_seq)

pending は構造的に高々 1（F3）なので evt_seq 単独でも今は取り違えない。しかしその十分性は
「poll_step が先頭停止する」という別の場所の実装詳細に依存する。F8 の
`InFlightCommand.generation` と同じ論法 —「現状足りているが、足りる根拠が他所にあるなら
照合フィールドを 1 本足して安全側に倒す」— を適用し、window を照合に加える。F6 の既存注記
（同一世代内の取り違えは守られていない）にもこれが答えになる。TS が別ウィンドウの token を
echo する類の wire バグは、silent な pending 消去ではなく loud な Protocol error になる。

**改訂 2 での置換理由（index → window token）**: index は APPLY で動く（`lib.rs:730`
`set_index`）。動く値を照合キーにすると「イベント発行時点の index」と「ack 到着時点の
index」の一致を保証する仕組みが別途要る。token は open から close まで不変なので、
その仕組みごと不要になる。

### Q3: 複数 Closing の teardown / respawn（キー置換のみ・論理は改訂 1 のまま)

- lifecycle は per-window map（§4.1）。`EVT_UI_CLOSED{w}` で `Closing`、DONE で `Closed`。
- `reset_after_child_exit` は非 Closed の全 window を
  `UiPumpResetOutcome { closed_windows, generation }` で返す。配送は route registry を
  drain して window ごとに `ClosedByRespawn`（§4.5）。
- `abandoned_safepoint` は per-window（map エントリ内 `Option<u64>`）。単一 Option のままだと
  2 件目の放棄が 1 件目を上書きし、1 件目の遅着 ack が warn 受理（`transport.rs:1446-1453`）
  でなく Protocol 拒否になる — 「保存は成功していたのに保存失敗に見える」という、この機構が
  潰した症状（`transport.rs:1587-1592`）の再発。per-window なら 1 window に高々 1・総数は
  同時 open 数で有界・respawn reset で全消去。
- エントリ削除は `lifecycle == Closed && abandoned_safepoint == None` のときのみ（F7 の
  per-window 版）。

### Q4: begin_open の拒否条件と冪等 open の表現（改訂 1 から実質不変）

pump の `begin_open(window)` は当該 key が `Closed`（不在含む）のときのみ `Opening` を予約。
それ以外は loud 拒否 — rack では token は open ごとに新規なので、この拒否は「token 再利用
バグ」の検出器であり、通常経路では発火しない。**「その stage は既に開いている」の loud
拒否は daemon の `index_binding` 検査（§4.5）が担う**（PH.2c の「MCP は冪等にしない」の
実装位置）。同 index 冪等は現行どおり TS 層:

1. TS DSL 層: `openPluginUiIdempotent`（`global.ts:996-1030`）の session fast-path +
   2 アンカー swallow（F14）
2. child: indexed open の `ALREADY_OPEN` → `CMD_RESULT_OK`（`ui_service.rs:505`）—
   desync 時の防衛・再同期経路（§4.6-(4) で token 採用を追加）
3. MCP: 非冪等版 `openPluginUi`（`global.ts:1032`）を直接呼び、daemon の loud 拒否が届く

**アンカー保全**: 拒否文言は binding 検査・pump 検査のどちら発でも
`"OPEN_UI requested while lifecycle is {:?}"` の並びを先頭に保つ（F14・§5 P10）。

### Q5: 帰属は window token・宛先は chain_path（2 レイヤ分離）

**原理**: 「開いているウィンドウ」は位置の性質ではなく **open という行為の産物**である。
だからウィンドウの同一性は open 時に発行する token で表し、位置（chain_path）は
「これから操作を届ける先」の解決にだけ使う。各層の持ち物:

| 層 | 保持者 | キー | 生成 / 破棄 |
|---|---|---|---|
| TS session | `Global.openPluginUiSessions` | **window token `w`**（値に `resolved.identity`・receiverId・indexAtOpen） | open 時に TS が採番・記録 / 保存成功・DONE・respawn で破棄 |
| wire（宛先） | `chain_path: [i]`（確定済み表現・不変） | — | コマンド発行時に TS が**現在の**登記チェーンから導出 |
| wire（照合） | `window: w`（**宛先とは別レイヤの照合トークン**） | — | open で採番・close / ack / event frame が携行 |
| daemon route | `PluginUiWiring` → per-window registry | `Option<u64>` | open 成功で insert / CloseDone・respawn で remove |
| daemon pump | `UiPumpState.windows` | `Option<u64>` | begin_open で生成 / Closed かつ abandoned なしで除去 |
| daemon binding | `index_binding: BTreeMap<u32, u64>`（現 index → w） | 現 index | open で insert / **APPLY の keep 写像で remap**・drop で除去 / close 完了で除去 |
| child | stage が保持する `window` cell（イベント arg に載せる） | — | OPEN_UI_AT の arg で受領 / close 完了で消滅 |

- **イベントの帰属**（`UI_CLOSED` / DONE / ClosedByRespawn → TS session → 保存 identity）は
  **token のみ**で行う。token は open から close まで不変なので、**APPLY と close の競合順序に
  関わらず誤帰属が起きない**。#601 I1（open 時 identity へ保存・再解決しない）は token が
  そのまま体現する。F15 の既存注記「index を永続キーへ流用しない」の徹底でもある。
- **コマンドの宛先**（open / close の届け先 stage）は chain_path。TS は発行時点の登記
  チェーンから現在 index を引く。位置は動くので、**close は (chain_path, window) の対で
  発行し、daemon と child の双方が「その位置に居るのは本当にその window か」を照合して
  不一致を loud にする**（§4.5 / §4.6-(3)）。位置のずれは「間違ったウィンドウを閉じる」
  ではなく「エラーで何も起きない」に倒れる。
- **owner の考慮点 1**（keep = 同一インスタンス確定・TS は旧→新写像を持つ）はそのとおりで、
  この写像は **daemon の `index_binding` の remap に使う**（§4.5）。daemon は
  `ApplyEffectChain` の plan（keep op が `prev_index` を持つ・実装設計書 §3.1-(5)）から
  同じ写像を自力で導出できるため、**新しい wire 経路は不要**。remap するのは binding
  （宛先解決の補助）だけで、帰属側（pump / route / session）は token キーなので
  remap 自体が存在しない — R5 が必要とした「remap とイベントの順序付け」問題が消える。

---

## 3. 採用する機構と却下案

### 採用: 安定 window token による帰属・宛先の 2 レイヤ分離

構成要素は 5 つ。(a) `UiPumpState` を「child 単位 generation + 単一 pending + per-window
lifecycle/abandoned map」へ（§4.1-4.4）。(b) engine_wrap の route を per-window registry に、
`index_binding` を新設し APPLY で remap（§4.5）。(c) event arg の encode/decode を
`orbit-audio-sandbox` の共有 codec に（§4.3）。(d) child: OPEN/CLOSE_UI_AT への token 携行と
照合・event arg の token 化（§4.6）。(e) TS: token 採番・session 簿記・`chain_path` 送出
（§4.7）。

### 却下案

| # | 案 | 却下理由 |
|---|---|---|
| R1 | v1 は 1 child 1 UI に制限（案 B） | owner 確定の DSL 表面（SC.10.10.1 規範 2-3）を後退させる。owner 判断 2026-08-28 で不採択済み |
| R2 | generation を per-window 化 | §2 Q1。1 つの事実（ring 世代）の N 重複製 |
| R3 | `pending_safepoint` を per-window map 化 | F3 により pending は構造的に高々 1。map は存在しない並行性を型で偽る。単一 `Option<PendingSafepoint>`（window 内包）が実態に正直 |
| R4 | **不変条件 I（open UI の index 不変）+ APPLY 前自動 close**（改訂 1 の採用案） | 🔴 **owner 原則 C-A 違反で差し戻し**（§0.5）。「ユーザーが閉じるまで開いたまま」を、シフトを理由に破る |
| R5 | index キーを維持し、APPLY commit を ring 上のマーカー event にして daemon の remap を ring 順序で行う | daemon 側の順序は解決するが、**TS 側が未解決**: WS 上でイベントフレームと APPLY 応答の到着順は ring 順序と同期しないため、TS session（index キー）の remap タイミングとイベント帰属の競合が残る。塞ぐにはイベントへ epoch を載せることになる — **それは「イベントに安定識別子を載せる」ことと同じであり、それなら token を載せれば remap 機構（新 EVT 種別・epoch 簿記・pump/route/TS の 3 箇所 remap）が丸ごと不要になる**。token 案が真に優越 |
| R6 | birth index（open 時 index）で帰属し `set_index` を廃止 | シフト後に別 stage が同じ birth 値へ到達すると衝突する: stage A の UI が birth 1 のまま open 中、APPLY 後に現在 index 1 へ来た stage B を open すると key 1 が二重予約 → begin_open が**別ウィンドウを理由に**拒否 → TS 冪等層が「もう開いている」と誤飲して **B の UI が silent に開かない**。token は open ごとに一意採番なので衝突が構造的に無い |
| R7 | daemon 独自 timeout でリング先頭を放棄 | 既存契約違反（`transport.rs:1293-1294`: 脱出は child が publish した事実だけを根拠にする） |
| R8 | `orbit-audio-sandbox` に serde_json を追加して arg を parse | 依存隔離ポリシー違反（F9）。arg は固定文法 2 形なので手書き厳密 parser が正直（§4.3） |
| R9 | 冪等 open を pump に実装 | PH.2c の「MCP は冪等にしない」が満たせない（§2 Q4）。経路知識を持たない層に経路依存の意味論を置かない |
| R10 | token を daemon が採番し open 応答で TS へ返す | 成立はするが、応答スキーマ変更 + TS の受領配管が増える。採番者 = 簿記の持ち主（TS）にすれば open 要求に載せるだけで済む（§4.7-(2)）。daemon は「使用中 token の再利用」を loud 拒否して一意性を防衛する |

---

## 4. 詳細設計

### 4.1 データ構造（`orbit-audio-sandbox/src/transport.rs`）

```rust
/// UI ウィンドウの安定識別子。None = 非 indexed（instrument / 旧単発 effect child）。
/// rack は Some(token)。token は TS が open ごとに一意採番する（§4.7-(2)）。
pub type UiWindowKey = Option<u64>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingSafepoint {
    window: UiWindowKey,
    evt_seq: u64,
}

#[derive(Debug)]
struct UiWindowState {
    lifecycle: UiLifecycle,          // 既存 enum（transport.rs:1241-1247）を流用
    /// この window で timeout 放棄した safepoint。遅着 ack を warn 受理するため保持。
    abandoned_safepoint: Option<u64>,
}

#[derive(Debug, Default)]
struct UiPumpState {
    /// child 単位。respawn reset でのみ増える（§2 Q1）。
    generation: u64,
    /// child 全体で高々 1（ring 先頭直列化・F3）。window を内包する（§2 Q2）。
    pending_safepoint: Option<PendingSafepoint>,
    /// window ごとの lifecycle と放棄水位。エントリは
    /// lifecycle == Closed && abandoned_safepoint == None で除去する。
    windows: BTreeMap<UiWindowKey, UiWindowState>,
}
```

- `BTreeMap`: reset の `closed_windows` 列挙・ログ・テストが決定的になる。件数は同時 open
  数オーダー。
- `None` キーは現行の単一 state と同値に振る舞う（1 エントリしか作られない）ため、
  **instrument / 旧単発 child の観測挙動は変わらない**（完了条件 7・U1）。
- 🔴 **`index_binding` は pump に置かない**（engine_wrap 側・§4.5）。pump は共有メモリ
  transport の座標器であり、チェーン編集（APPLY）の知識を持ち込まない — 層の責務を混ぜると
  「pump の remap と ring イベントの順序」という R5 型の問題を pump 内に再輸入してしまう。
  pump のキーは不変な token だけにする。

### 4.2 状態機械と不変条件

**per-window lifecycle**（既存 `UiLifecycle` の遷移を window ごとに独立化）:

```
Closed --begin_open(w)--> Opening --finish_open(w, true)--> Open
                          Opening --finish_open(w, false)--> Closed
Open   --poll: EVT_UI_CLOSED{w}--> Closing
Closing --poll: EVT_UI_CLOSED_DONE{w}--> Closed
（任意状態） --reset_after_child_exit--> エントリ消滅（= Closed）
```

**不変条件**（実装コメント・テストで pin する）:

1. **G1**: `generation` は child 単位。増分点は `reset_after_child_exit` のみ（pump lock 内）。
2. **G2**: `pending_safepoint` は高々 1。根拠は ring 先頭直列化（F3）。poll_step の先頭停止
   構造を変える変更はこの不変条件の再設計を伴う。
3. **G3**: ack が前進する条件は
   `generation 一致 ∧ pending == Some((window, evt_seq)) ∧ ack + 1 == evt_seq ∧ evt_seq <= published`。
   ただし per-window の遅着放棄受理
   （`windows[w].abandoned_safepoint == Some(evt_seq) ∧ ring ack >= evt_seq`）が先行する。
4. **G4**: `begin_open(w)` は `windows[w]`（不在 = Closed）が `Closed` のときのみ成功。
   他 window の状態を参照しない。
5. **G5**: エントリ除去は `Closed ∧ abandoned == None` のときのみ。
6. **G6**: リング先頭で停止した `EVT_UI_CLOSED{w}` の放棄エスケープは、**直後のイベントが
   同 window の `EVT_UI_CLOSED_DONE{w, timeout-without-save}` である場合のみ**成立する
   （§4.6-(2) の child 側順序保証と対）。
7. **G7（token 一意性の防衛）**: rack の `begin_open(Some(w))` で `windows[Some(w)]` が既に
   存在（非 Closed）していたら loud 拒否 — TS 採番の重複・再利用バグの検出器。

### 4.3 event arg の encode / decode（共有 codec）

置き場所は `orbit-audio-sandbox/src/transport.rs`（serde 不使用・手書き）。child は本 crate に
依存済み（`ui_service.rs:7-13`）なので、`ui_service.rs:101-118` の `event_arg` を共有関数
呼び出しへ置換する（child 変更 §4.6-(1)）。

```rust
/// EVT_UI_CLOSED: token なし → ""、あり → {"window":w}
pub fn encode_ui_closed_arg(window: UiWindowKey) -> String;
/// EVT_UI_CLOSED_DONE: token なし → completion 素文字列、
/// あり → {"window":w,"completion":"safepoint-completed" | "timeout-without-save"}
pub fn encode_ui_closed_done_arg(window: UiWindowKey, completion: UiCloseCompletion) -> String;

/// 逆関数。上記の固定文法だけを受理し、それ以外は Err（loud・silent fallback しない）。
pub fn decode_ui_closed_arg(arg: Option<&str>) -> Result<UiWindowKey, String>;
pub fn decode_ui_closed_done_arg(arg: Option<&str>)
    -> Result<(UiWindowKey, UiCloseCompletion), String>;
```

- decode は厳密一致の固定文法（`{"window":` + 10 進 u64 + …）。汎用 JSON parser を書かない。
- encode/decode を同居させ **round-trip property test を同 mod に置く**（§5 P14）。
  「child の書式と daemon の読解が別 crate で乖離する」事故類型を型と同居テストで塞ぐ。
- 最大長は `{"window":18446744073709551615,"completion":"timeout-without-save"}` = 59 byte
  < `EVT_ARG_BYTES = 256`（F10）。
- 🔴 committed 済みの child は `{"index":n}` を書く（§0.1）。**この arg 書式は daemon 側が
  まだ読めていない**（F20/§0.1 — DONE は Protocol error になる）ので、書式を `window` へ
  変えることに互換性の負債はない。daemon と child は同一ビルド配布（実装設計書 §3.1-(7)）。

### 4.4 `UiEventPump` 各メソッドの変更（transport.rs）

- **`begin_open(&self, window: UiWindowKey)`**（`:1326`）: G4・G7。拒否文言は
  `OPEN_UI requested while lifecycle is {:?} (window …)` — **`lifecycle is {:?}` の並びを
  現行から変えない**（F14 アンカー・§5 P10）。
- **`finish_open(&self, window: UiWindowKey, succeeded: bool)`**（`:1341`）: 当該エントリが
  `Opening` のときのみ `Open` / `Closed`（Closed ならエントリ除去）。
- **`poll_step`**（`:1357`）:
  - `EVT_UI_CLOSED`: `decode_ui_closed_arg` で window を得て（現行は arg を読んでいない・
    F20 — ここが新規）、`windows[w].lifecycle = Closing`（エントリ不在なら作る — 追跡外の
    close は現行同様 permissive に受けて通知まで流す）。放棄検査
    `is_abandon_done_published` に **window 一致を追加**（G6・次イベントの arg を decode）。
    通知は `UiPumpNotification::Safepoint { generation, evt_seq, window }`。sink false 時の
    再試行 dedupe は `pending_safepoint != Some(PendingSafepoint{window, evt_seq})` 比較
    （現行 `:1387` と同型）。
  - `EVT_UI_CLOSED_DONE`: `decode_ui_closed_done_arg` で `(window, completion)`。通知は
    `CloseDone { completion, window }`。sink 成功で `Closed` 化（G5 の除去判定）。
- **`ack_safepoint(&self, generation: u64, window: UiWindowKey, evt_seq: u64)`**（`:1432`）:
  G3。遅着放棄の warn 受理（`:1446-1453`）は `windows[w].abandoned_safepoint` に対して行う。
- **`reset_after_child_exit`**（`:1473`）: pending があれば現行どおり error ログ。
  `closed_windows: Vec<UiWindowKey>` = 非 Closed の全キー（BTreeMap 順）。map 全消去・
  generation 増分。lock 順序 **pump → mailbox** は不変（`transport.rs:1278`・`:1489`）。
- **`final_drain`**（`:1504`）: poll_step と同じ decode。safepoint は現行どおり error ログ +
  当該 window の `abandoned_safepoint` に記録して ack（`:1520-1546`・記録は `:1532` の
  per-window 版）。終了時、全エントリを `Closed` 化。
- **`UiPumpNotification`**（`:1189`）: `Safepoint { generation, evt_seq, window: UiWindowKey }`
  / `CloseDone { completion, window: UiWindowKey }`。

### 4.5 engine_wrap.rs / respawn guard の変更

- **route を per-window registry に**: `PluginUiWiring.target`（`:2797-2801`）を
  `Arc<Mutex<BTreeMap<UiWindowKey, PluginUiTarget>>>` へ。型 alias `PluginUiHandles`
  （`:7463`）も追随。`PluginUiTarget`（`:7773-7781`）に `window: Option<u64>` を追加して
  イベントフレームへ serialize する（`index` フィールドは **open 時点の index** として残す —
  帰属には使わせない情報表示用。§4.7-(3)）。
- **`index_binding` を新設**（rack child slot ごと・`BTreeMap<u32, u64>` = 現 index → token）:
  - open 成功で insert・close 完了（CloseDone）/ respawn で除去
  - **`ApplyEffectChain` ハンドラが plan の keep 写像（`prev_index` → 新位置）で remap する**
    （drop された index のエントリは除去 — その window の close cycle は child の防御 close が
    event ring 経由で完走させ、CloseDone で route/pump からも消える）
  - 用途は 2 つ: (i) **MCP 二重 open の loud 拒否**（open 要求の chain_path 位置に binding が
    既にあれば `OPEN_UI requested while lifecycle is {:?}` 形で拒否 — アンカー保全）、
    (ii) close の宛先照合の第一段
  - binding は**宛先解決の補助**であり誤っても壊れない設計にする: 最終照合は child が行う
    （§4.6-(3)）ので、binding の staleness は「wrong window を閉じる」ではなく
    「loud エラー」に倒れる
- **`enqueue_plugin_ui_notification`**（`:2810-2863`）: 通知の `window` で registry を引く。
  `Safepoint` → clone・`CloseDone` → remove。エントリ不在は現行の「相関する UI 要求なし →
  消費」の意味論を維持（warn は window 付き）。`try_lock` / 非ブロッキング / Poisoned 回復の
  構造は変えない（sink 契約 `transport.rs:1289-1292`）。
- **`enqueue_plugin_ui_closed_by_respawn`**（`:2865-2880`）: registry を**全 drain** し
  window ごとに `ClosedByRespawn` を配送。`UiPumpResetOutcome.closed_windows` は突合ログ
  （pump と route の簿記乖離の検出器）。binding も全消去。
- **`open_outproc_plugin_ui`**（`:5634`）: 引数に `window: Option<u64>` を追加（rack 必須・
  非 rack は None）。順序: binding 検査（loud 二重 open 拒否）→ `pump.begin_open(key)` →
  route insert → `issue_open_ui_at`（arg に `"window"` を追加）→ `finish_open`。失敗時
  rollback は現行（`:5678-5684`）の per-window 版 + binding 巻き戻し。
  `key = rack_target.then(|| window)`（`ui_handles` の bool・`:7342-7359` が判定源）。
- **`close_outproc_plugin_ui`**（`:5690`）: 引数に `window` を追加。照合は
  (i) `index_binding[chain_path] == window`（第一段・loud）、(ii) route registry に
  `window` キーが存在し role/bus/instance が target と一致（**index は比較しない** —
  F23 の全等値比較からの意図的変更: route の index は open 時点値でありシフト後は
  現在 index と食い違うのが正常）。child へは `{"index": i, "window": w}` を送る。
- **`ack_outproc_ui_safepoint`**（`:5721`）: 引数に `window` を追加し
  `pump.ack_safepoint(generation, key, evt_seq)` へ渡す。🔴 **per-stage 検分
  （`validate_effect_chain_target`）を ack 経路から外す**（F24 の変更）: 遅着 ack の時点で
  当該 stage は drop 済みでありうる（F7 の遅着放棄受理と drop close の組み合わせ）。ack の
  正当性は (generation, window, evt_seq) と in-order head が全て担っており、stage の現存は
  要件でない。target による child slot 解決だけ残す。route 照合は「エントリがあれば
  role/bus/instance 一致・なければ通す」（現行 `:5745-5756` の遅着意味論を per-window で維持）。
- **`outproc_respawn_guard.rs`**（`:36-89`）: シグネチャを registry / binding 型に追随。
  ロジック構造は不変。
- **instrument 経路**（`outproc_instrument.rs:494-529` ほか）: 全呼び出しが `None` を渡すだけ。
  binding は rack slot にのみ存在。観測挙動は不変（完了条件 7）。

### 4.6 child 側への提案変更（ブリーフ §3.3 の「変更が必要なら理由を明記」条項に基づく）

**(1) arg encode の共有化**（機械的）: `ui_service.rs:101-118` を §4.3 の共有 encode へ置換。
書式の真実を 1 箇所にし round-trip テストで乖離を封じる。

**(2) 🔴 `UiEventHub` に close-cycle 順序ゲートを追加**（必須・机上解析 U2・改訂 1 から不変。
**token 化は本件の条件を変えない** — デッドロックは「どの識別子を運ぶか」でなく「ring 容量と
放棄エスケープの前提」の問題であり、本改訂は ring に新イベントを足さないため再評価結果は
同一）:

現行 hub は close cycle を跨ぐ publish 順序を守らない（F13）。2 枚の UI がともに close に
入り engine が ack を返せない状況で:

1. `UI_CLOSED{w1}` が seq `s` で publish → daemon が safepoint 通知 → ack 待ちで先頭停止
2. hub は続けて `UI_CLOSED{w2}` を `s+1` に publish（F2: `evt_ack >= s-1` なので載る）
3. w1 が 10 秒 timeout → Phase B（F12）→ `UI_CLOSED_DONE{w1, timeout}` を publish しようと
   するが、`s+2` は `evt_ack >= s` が要る（F2）— **先頭 `s` が未 ack なので載らない**
4. daemon の放棄エスケープは **`s+1` に DONE がある場合のみ**成立（`transport.rs:1576-1585`）。
   `s+1` は `UI_CLOSED{w2}` — 成立しない
5. → **リング先頭が永久に詰まる**。以後この child の UI は open 不能（F11 の drain ゲート）。
   respawn まで回復しない

`EVT_SLOTS = 2` の導出は「**1 つの close cycle** の占有上限 = 2」（`transport.rs:83-103`）で
あり、cycle が interleave しない前提が暗黙にあった。多重ウィンドウはこれを破る。pump 側では
直せない（R7: daemon timeout は契約違反・イベントは既に ring 内）ため、hub に:

> `UI_CLOSED{x}` を ring に載せたら、その cycle の `UI_CLOSED_DONE{x}` を載せるまで
> 他イベントを ring に載せない（hub 内 `open_cycle: Option<UiWindowKey>` で追跡。他 window の
> close event は `pending` deque で待たせる）

- 待たされる側の状態機械は無変更で耐える（F12 の遅延 publish 経路）
- 副作用: 異常系（engine ack 不能）では待たされた window が timeout-without-save に倒れうる
  が、**有界・loud**（現行単一 UI の最悪値と同じ）。正常系では cycle は秒未満で完了
- この保証があって初めて G6 が健全になる

**(3) 🔴 `CMD_OPEN_UI_AT` / `CMD_CLOSE_UI_AT` の token 携行と照合**（本改訂の核）:

- `OPEN_UI_AT` arg: `{"index":i,"title":t,"window":w}`。stage は open 中 `w` を保持し
  （現行の `event_index: Rc<Cell<u32>>` の配管を token 用に転用 — `ui_service.rs:475-480` の
  `set_index` は **event 用途では廃止**。イベント arg は index でなく `w` を載せる）、
  `handle_ui_at` の stage 解決（現在位置・`lib.rs:766-781`）は不変
- `CLOSE_UI_AT` arg: `{"index":i,"window":w}`。child は `stages[i]` の保持 token と `w` を
  照合し、**不一致は `CMD_RESULT_BAD_ARG`**（ウィンドウは閉じない）。これが宛先照合の
  最終段 — daemon binding が stale でも（U4 の直列化粒度に関わらず）**「別のウィンドウを
  閉じる」は構造的に起こらない**
- APPLY commit の `set_index` 呼び出し（`lib.rs:730`）は不要になる（イベントが index を
  運ばなくなるため）。ただし将来の診断用に stage の現在 index 表示が要るなら残害はない —
  実装時にどちらでも可・イベント経路から切れていることだけをテストで pin（§5 H5）

**(4) indexed open の `ALREADY_OPEN` 受理時に新 token を採用する**: desync（TS/daemon 簿記
喪失・child は open のまま）からの再 open で、child が `ALREADY_OPEN` → OK を返すとき
（`ui_service.rs:505`）、**arg の `w` を stage の保持 token に上書きする**。以後の close
event は新 token で出る → 再構築された TS session / daemon 簿記と自己整合する
（`set_index` セルの転用がここでも効く）。

### 4.7 TS 側の変更

- **(1) ~~wire の `chain_path` 送出~~ — 🔴 **実装済み・本 PR のスコープ外**（main の設計チェックで
  判明・2026-08-29）: 設計執筆後に #628 の `3b634850`「feat(dsl): write a whole effect rack as
  an array」が `daemon-client.ts` に `pluginChainPath()` を入れ、`openPluginUi` /
  `acceptClosePluginUi` / `ackUiSafepoint` / save の**4 経路すべてが `chain_path` を送出**して
  いる（`daemon-client.ts:576,604,613,625`）。**F16 の「index ≠ 0 が wire で 0 に化ける」は
  もう起きない。** 残る作業は同メソッド群への `window` 追加のみ（次項）。
  受け入れ基準 **S2 は「chain_path を付ける」から「chain_path と window の両方が乗る」へ
  読み替える**（テストは残す — 退行の検出器として有効）。
- **(2) token の採番と携行**: token は **TS（`rust-engine-player`）が採番**する（R10）。
  一意性要件は「daemon プロセスの生涯で再利用しない」— 単調カウンタに起動時刻由来の上位
  bit を併せる等（TS 再起動 × daemon 生存のケースで衝突しないため・§7-6）。
  `openPluginUi` / `acceptClosePluginUi` / `ackUiSafepoint` の wire params に `window: w` を
  追加（**宛先 `chain_path` とは別のフィールド** — 確定済み宛先表現は不変・制約 3）。
- **(3) イベント帰属の token 化**: イベントフレームの `window` を読み、
  `openPluginUiSessions` を **token キー**で引く（値: `resolved`（identity 含む）・
  `receiverId`・`indexAtOpen`）。`savePluginUiStateAtSafepoint`（`global.ts:833-855`）・
  `settlePendingPluginUiCloses`（`rust-engine-player.ts:641-650`）・respawn 破棄（F19）を
  token 照合に変更。**イベントの `target.index` を帰属に使うコードを残さない**
  （open 時点値であり表示・ログ専用と明記する）。非 rack（`window` なし）は従来の
  target 照合のまま。
- **(4) DSL 名前形と冪等判定**: `ui("名前")` は名前 → 登記チェーンの一致 **catalog 要素**
  全列挙（実装設計書 §3.4-(8)・不変）。各要素について session を **instanceId で**検索
  （session 値に identity があるので逆引き可能）: あれば no-op（冪等 fast-path）、なければ
  現在 index を宛先に新 token で open。`hasOpenPluginUi` は (receiverId, index) 照合から
  instanceId 照合へ変更（シフト後の再評価で「開いているのに index が変わったから開き直す」
  誤動作 — C-B 違反の芽 — を防ぐ）。
- **(5) close**: session（token）から `receiverId` / identity を得て、**現在の**登記チェーン
  における当該 instance の位置を chain_path として発行し、token を添える。instance が既に
  チェーンに居ない（drop 済みで close cycle も完了 → session 消滅）場合は従来どおり
  「no recorded open session」の loud エラー（`global.ts:1080-1090`）。
- **(6) APPLY 前の close 義務は drop / replace 対象に限る**（実装設計書 §3.4-(5) の従来
  範囲を**維持**・改訂 1 が加えたシフト keep への拡大は**撤回**（C-A））。順序は
  保存 → close → APPLY（R15）のまま。

### 4.8 チェーン編集と open ウィンドウの共存（C-A の実現）

シナリオで確認する。stage 構成 `[X, Y, Z]`・Z（index 2）の UI が token w で open 中:

1. **先頭 drop の APPLY**（`[Y, Z]` へ・Z は index 1 にシフト）:
   - TS: drop 対象 X に open UI なし → pre-close なし。APPLY 発行
   - daemon: plan の keep 写像で `index_binding` を {2→w} から {1→w} へ remap。
     route / pump / TS session は token キーなので**無変更**
   - child: commit で stages 再構成。Z の UI ウィンドウは touch されない（**close コマンドは
     どこからも発行されない** — 完了条件 3 の実体）
   - この間にユーザーが Z のウィンドウを閉じても、event は `{"window":w}` を運ぶので
     帰属は APPLY との順序に関わらず正しい（誤帰属の窓が存在しない）
2. **シフト後の close**: TS は現在チェーンから Z の位置 = 1 を引き
   `{chain_path:[1], window:w}` を発行。daemon binding[1] == w ✓・child stages[1].token == w ✓
   → close cycle → safepoint は session(w) の **open 時 identity** へ保存（#601 I1）
3. **open UI のある stage を drop する APPLY**: TS が APPLY 前に save → close（§4.7-(6)）。
   TS が閉じ損ねた場合（バグ・レース）は child の防御 close（`lib.rs:733-736`）が event ring
   経由で cycle を完走させ、token 帰属で session も正しく畳まれる（保存は safepoint 経路 —
   ただし U5 のとおり防御経路の保存完了は保証に含めない。一次経路が正）
4. **APPLY 直後の stale 宛先 close**（TS の登記更新前に発行された close が新配置に届く等）:
   binding / child token 照合のどちらかで不一致 → **loud エラー・どのウィンドウも閉じない**。
   ユーザー操作の再実行で解消（位置ずれが破壊でなくエラーに倒れる — C-A/C-B を壊す側への
   フォールバックが存在しない）
5. **`enabled: false` への切替**（SC.10.2 の状態保持バイパス・keep + enabled 差分の op）:
   **UI は開いたまま**。§0.5 の軸（インスタンスの生存）に従う — バイパスは audio ループの
   走査で skip されるだけ（実装設計書 §3.1-(4)）で、プラグインインスタンスも UI view も
   生きている。DAW の deactivate/bypass と同じ挙動: エディタは開いたまま操作でき、
   パラメータ編集は state に反映され続け、音声処理にだけ反映されない（re-enable で編集後の
   状態が鳴る）。enabled 切替は keep op なので binding・route・pump・session のどこにも
   変化がなく、**UI 系のコマンドは一切発行されない**（W8 が enabled 切替込みで pin する）。
   逆向き（enabled: false 中に UI を開く）も同様に**通常どおり開ける** — 開けないと
   「バイパス中に音を出さずに音色を仕込む」という bypass の主用途が成立しない

---

## 5. 失敗モード一覧 ↔ 受け入れ基準テスト（1:1 対応表）

置き場: P\* = `orbit-audio-sandbox/src/transport.rs` の `mod tests`（`TestRegion` 方式・
`:2148` 以降と同居）、W\* = `engine_wrap.rs` `plugin_ui_event_routing_tests`（`:7838` 以降）
ほか daemon unit、H\* = `orbit-child-runtime/src/ui_service.rs` / rack child の `mod tests`
（C15・`ui_service.rs:1083` の隣）、S\* = TS（`tests/core/` の plugin-ui spec /
`effect-rack.spec.ts`）。**テストの無い失敗モード、対応する失敗モードの無いテストは無い。**
変異は 4 種（分岐反転 / 回数 / 順序 / 引数）を表全体で横断している。

| # | 失敗モード | 検出するテスト | 変異（red の確認方法） |
|---|---|---|---|
| P1 | 2 window 同時 open が拒否される（本丸の退行） | `begin_open(Some(1))` → `begin_open(Some(2))` 双方 Ok・`finish_open` 後どちらも Open | per-window map を単一 lifecycle に戻す → red |
| P2 | 使用中 token の再 begin_open が silent 二重予約になる（G7） | `begin_open(Some(1))` 成功後、再度 `begin_open(Some(1))` → Protocol error・状態不変 | G4/G7 の lifecycle 検査を削除 → red |
| P3 | 別 window の ack が pending を消す（取り違え） | pending = (Some(2), s) で `ack_safepoint(gen, Some(1), s)` → Protocol error・pending 残存。正しい `(gen, Some(2), s)` で前進 | ack の window 照合を削除 → red（引数変異） |
| P4 | 旧世代 ack の受理（既存保全の退行） | respawn reset 後に旧 generation で ack → `GenerationMismatch` | generation 照合を削除 → red |
| P5 | safepoint 通知の window 落ち / 誤配送 | `EVT_UI_CLOSED` arg `{"window":2}` を poll → 通知 `Safepoint{window: Some(2)}` | decode を常に None に固定 → red（引数変異） |
| P6 | token 付き DONE arg が Protocol error（**現行の実バグ**・§0.1） | arg `{"window":1,"completion":"safepoint-completed"}` を poll → `CloseDone{window: Some(1), SafepointCompleted}`・ring 前進 | 旧・完全一致 parse に戻す → red |
| P7 | 非 indexed arg の退行（instrument 経路） | 空 arg の `UI_CLOSED` / 素文字列 DONE → `window: None` で従来どおり完走 | decode が None 形を Err に → red |
| P8 | respawn reset が open window を取りこぼす | windows = {1: Open, 2: Closing} で reset → `closed_windows == [Some(1), Some(2)]`・map 空・generation +1 | 列挙を最初の 1 件で打ち切り → red（回数変異） |
| P9 | 放棄水位の上書き（別 window の放棄が先行放棄を消す） | w1 放棄(s0) → w2 放棄(s2) → 両方の遅着 ack が warn 受理（2 回とも Ok） | per-window abandoned を単一 Option に戻す → red（1 件目の ack が Protocol error） |
| P10 | begin_open / binding 拒否文言のアンカー崩れ（F14 との結合） | 拒否 message が `"OPEN_UI requested while lifecycle is Open"` を**部分文字列として含む**ことを rust unit で pin（pump 発・binding 発の両方） | 文言の語順変更（window を lifecycle の前に挿入）→ red |
| P11 | 別 window の DONE で放棄エスケープが成立してしまう | 先頭 `UI_CLOSED{w1}`・次 slot に `DONE{w2, timeout}` → エスケープ**しない**。次 slot が `DONE{w1, timeout}` ならエスケープする | `is_abandon_done_published` の window 照合を削除 → red |
| P12 | エントリ削除が早すぎて遅着 ack 経路が消える（G5） | DONE 完了（Closed）だが abandoned 有りの window → エントリ生存 → 遅着 ack warn 受理 → エントリ消滅 | Closed で即削除に変える → red（順序変異） |
| P13 | pending の再通知 dedupe 退行 | sink が 1 回目 false → 2 回目 true の fixture で、Safepoint 通知が**ちょうど 2 回**・pending は 1 つ | dedupe 比較から window を落とし常に再通知 → red（回数 assert） |
| P14 | encode/decode の乖離（crate 間の書式ずれ） | 全 `(UiWindowKey, completion)` 組の round-trip property（encode → decode == 恒等） | encode 側の JSON キー名を変える → red |
| W1 | route registry の誤配送（CloseDone が全エントリを消す） | registry = {w1: t1, w2: t2} で `CloseDone{window:w2}` → t2 のみ remove・t1 残存・event target == t2 | remove を clear に変える → red（回数変異） |
| W2 | Safepoint 配送先の取り違え | `Safepoint{window:w1}` → 配送 event の target == t1（t2 でない） | lookup を「最初のエントリ」に固定 → red（引数変異） |
| W3 | respawn の ClosedByRespawn が 1 件しか出ない | registry 2 件で respawn → `ClosedByRespawn` が**ちょうど 2 通**・target 集合一致・binding 空 | drain を 1 件で打ち切り → red |
| W4 | ack 経路が window を pump へ渡さない（§0.1 の現行欠落の再発） | `ack_outproc_ui_safepoint(…, window=w2, …)` が `pump.ack_safepoint` に Some(w2) を渡す（fixture pump で引数捕捉） | 渡す window を常に None に → red（引数変異） |
| W5 | 🔴 APPLY の keep 写像で binding が remap されない（C-A の配線） | binding {2→w}・先頭 drop の plan 適用 → binding {1→w}。その後 `close(chain_path=[1], window=w)` が受理される | remap を削除 → red（close が binding 不一致で拒否） |
| W6 | MCP 二重 open が silent に通る | binding[i] 存在下で `open(chain_path=[i], window=新)` → loud 拒否（P10 アンカー形）・child へ投函されない | binding 検査を削除 → red |
| W7 | stale 宛先 close が別ウィンドウを閉じる | binding {1→w1} で `close(chain_path=[1], window=w2)` → loud エラー・close コマンド不発行 | binding 照合を削除 → red（引数変異） |
| W8 | 🔴 keep シフト / enabled 切替で UI が勝手に閉じられる（**C-A の直接 pin**・§0.5 の軸） | シフトと `enabled: false` 切替を含む all-keep plan の適用で、`issue_close_ui_at` が**一度も呼ばれない**（mailbox spy で回数 0 assert）+ 全 window の lifecycle 不変 | 改訂 1 の「シフト keep を pre-close」を再導入 → red / enabled:false の keep を close 対象に加える → red（いずれも回数変異: 0 でなくなる） |
| W9 | drop 対象の binding が remap 後も残る | drop を含む plan 適用 → dropped index の binding エントリ消滅・survivor は remap 済み | drop 除去を削除 → red |
| W10 | ack 経路の per-stage 検分が遅着 ack を弾く（F24 の外し漏れ） | drop 完了後の遅着 ack（放棄受理経路）が target 解決のみ余で pump に届き warn 受理される | `validate_effect_chain_target` を ack 経路に残す → red |
| H1 | close-cycle 順序ゲートの不在（§4.6-(2) デッドロックの入口） | w1 close 開始（`UI_CLOSED{w1}` publish 済・未 ack）→ w2 close 要求 → ring に `UI_CLOSED{w2}` が**載らない**（seq 不増）。w1 の DONE 後に w2 が載る | ゲート削除 → red（`UI_CLOSED{w2}` が s+1 に載る） |
| H2 | 放棄エスケープの永久詰まり（統合・U2 の実証） | fixture ring で: w1 close → ack 停止 → w2 close → w1 timeout。`DONE{w1,timeout}` が s+1 に載り、daemon 側 poll が先頭を放棄できる | H1 ゲート削除 → red（先頭が進まない） |
| H3 | 他 window close 進行中の open 拒否契約（F11 の明文化） | w1 の close cycle 中に別 stage へ `CMD_OPEN_UI_AT` → `CLOSING_IN_PROGRESS`。cycle 完了後は open 成功 | drain 判定を恒真に → red |
| H4 | 🔴 token 不一致の close が別ウィンドウを閉じる（最終防衛） | `CLOSE_UI_AT {"index":1,"window":誤}` → `CMD_RESULT_BAD_ARG`・stages[1] のウィンドウ生存。正しい token で close 成功 | child の token 照合を削除 → red |
| H5 | close event が token でなく index を運ぶ（帰属の退行） | open 時 token w の stage を APPLY でシフト後に close → event arg == `{"window":w}`（新旧どちらの index も含まない） | event arg を現在 index 形へ戻す → red |
| H6 | `ALREADY_OPEN` 再 open で token が採用されない（§4.6-(4)） | open(w1) → 簿記喪失を模して open(w2) が `ALREADY_OPEN`→OK → その後の close event が **w2** を運ぶ | 採用処理を削除 → red（event が w1 のまま） |
| S1 | 🔴 シフト後 close の宛先導出と identity 保全（C-A の TS 端） | open at index2（token w・identity 記録）→ 登記を先頭 drop で更新 → close 発行の wire args == `{chain_path:[1], window:w}`・保存呼び出しの identity == open 時のもの | 宛先導出を indexAtOpen 固定に → red（引数変異）/ identity を現在チェーンから再解決 → red |
| S2 | chain_path 未送出（F16 の穴） | `daemon-client` unit: open/close の request payload に `chain_path: [n]` と `window` | chain_path 付与を削除 → red |
| S3 | イベント帰属を index でやってしまう（誤帰属の再導入） | session {w: identity_A} 登記後、`PluginUiClosed{target.index=別値, window:w}` → identity_A へ保存・ack は `window:w` を echo | 帰属を target.index 照合に変える → red |
| S4 | 冪等判定が index 照合のままシフトで二重 open する（C-B） | open 済み instance がシフトした後の `ui("名前")` 再評価 → open 発行 **0 回**（instanceId 照合で no-op） | 判定を (receiver, index) 照合に戻す → red（回数変異） |
| S5 | drop 対象 open UI の APPLY 前 save→close の順序退行（§4.7-(6)・従来義務の維持） | drop plan で save → close → APPLY の呼び出し順 assert | close と APPLY の順序を逆転 → red（順序変異） |
| E2E-1 | 同名 2 insert の全開き（SC.10.10.1 規範 2-3・完了条件 2） | gated: rack `[A, A]` → `ui("A")` → 2 ウィンドウ生存を確認 → 片方 close → 保存 → 再評価で冪等 | （E2E は変異対象外・実装設計書 §6 の規約に従う） |
| E2E-2 | 🔴 シフトをまたぐ open UI の生存と保存（完了条件 3・C-A） | gated: `[X, Z]` で Z の UI open → 先頭 drop の再評価 → ウィンドウ生存確認 → close → Z の identity で state 保存確認 | 同上 |

**変異 4 種の横断確認**: 分岐反転 = P2/H3・回数 = P8/P13/W1/W3/W8/S4・順序 = P12/S5・
引数 = P3/P5/W2/W4/W7/S1/S3。

---

## 6. 触ってはいけないもの

1. **quiesce / `shutdown` latch / `clear_quiesce_unless_shutdown` の SeqCst 指定**（#625 が
   潰した UB レースの再導入禁止）。本設計は一切触れない。
2. **RT コード**: `orbit-audio-native` / `OutProcEffectPostProcessor::process`。UI pump は
   watchdog スレッドの持ち物であり、audio callback 側に分岐を足さない。
3. **`chain_path`（0 始まり整数配列・v1 長さ 1）の wire 宛先表現**（確定済み）。`window` は
   **宛先ではなく照合トークン**として別フィールドに置く（制約 3 準拠）。
4. **audio シーケンスの `play()` 意味論**（プロジェクト規則 5）。
5. **`EVT_SLOTS = 2` とその導出**（`transport.rs:83-103`）。§4.6-(2) のゲートは「1 cycle
   占有 ≤ 2」の前提を**回復する**変更であり、slot 数は変えない。ring に新イベント種別も
   足さない。
6. **lock 順序 pump → mailbox**（`transport.rs:1278`・`:1489`）と sink の非ブロッキング契約
   （`transport.rs:1289-1292`）。
7. **child の 10 秒 close timeout より前の daemon 独自 timeout の新設禁止**
   （`transport.rs:1293-1294`）。
8. **`EventRingHost` の poll-gate CAS**（`transport.rs:1297-1298`）。
9. **mailbox の generation 機構**（`transport.rs:866-905`）— UI pump の generation とは別物。
10. **instrument 経路の観測挙動**（完了条件 7）。`UiService::new`（非 indexed）の意味論・
    instrument child の binary は無変更。
11. **`openPluginUiIdempotent` の 2 アンカー方式**（F14）— 本設計は文言互換（P10）で守る側。
12. 🔴 **owner 原則 C-A / C-B**（§0.5）: いかなる実装都合でも「open 中 UI の自動 close」
    「ユーザーの別操作による自動 open」へフォールバックしない。唯一の例外は drop / replace
    された instance の close（「対象の消滅」・owner 確定 2026-08-28）。`enabled: false` は
    例外に**含まれない**（インスタンス生存 → 開いたまま・§4.8-(5)）。

---

## 7. 確信度が低い決定と反証方法

🔴 実コードで確認した項目（§0.3 F1-F24・行番号つき）と推論で置いた項目を区別する。
以下は**推論を含む**決定。

| # | 決定 | 確信度 | 推論部分 | 反証方法 |
|---|---|---|---|---|
| 1 | §4.6-(2) の ring デッドロックは実在する | 中〜高 | F2/F3/F12/F13/`transport.rs:1576-1585` からの**机上組み立て**。実測していない。**token 化は条件を変えない**（ring に新イベントを足さないため）という再評価も机上 | **実装の最初に H2 の再現 fixture を書く**。再現しなければゲートは防御実装に格下げし本書に追記。テストは残す |
| 2 | binding remap の写像は plan（keep の `prev_index`）から一意に導出できる | 高 | plan 形式は実装設計書 §3.1-(5) と `orbit-effect-rack-child/src/lib.rs:723-731`（keep の prev_index 消費・重複 keep は prepare で拒否）で確認。daemon 側 plan 構築コードは本ブランチで進行中のため、daemon が同じ写像を持てることは**構造からの推論** | W5 を daemon の実 plan 経路に対して回す。導出不能な plan 形が見つかったら wire に写像を明示搬送する形（owner 考慮点 1 の直接形）へ切り替え、本書を改訂 |
| 3 | 待たされた close の timeout-without-save 化（§4.6-(2) 副作用）は受容可能 | 中〜高 | 発生条件（engine ack 不能 + 多重 close）の希少性は推定。有界・loud で現行単一 UI の最悪値と同じ | H2 fixture で副作用の発生条件を実証し、gated E2E（正常系）で非発生を確認 |
| 4 | `Option<u64>` キーで instrument 経路が無変更に保てる | 高（コード確認済み） | `ui_handles` の bool が唯一の分岐源であることは `engine_wrap.rs:7342-7359` で確認。全 call site の網羅は grep ベース | 完了条件 7（既存テスト無修正 green）が反証装置 |
| 5 | TS の message アンカーは P10 の語順維持で守れる | 高 | 2 アンカー（F14）は確認済み。TS 側に他の文言依存が無いことは grep の範囲 | 実装時に `rg "lifecycle is" packages/` を回し、依存箇所を P10 の対象に全列挙 |
| 6 | TS 採番 token の一意性（daemon 生涯スコープ） | 中〜高 | TS 再起動 × daemon 生存で単調カウンタが巻き戻るケースは**運用推定**（頻度未計測）。G7 + W6 の loud 拒否が最終防衛なので silent 事故にはならない | 採番形式（時刻上位 bit + カウンタ）の衝突確率を実装時にコメントで見積もる。G7 の loud 発火を TS 再起動シナリオの結合テストで確認 |
| 7 | drop 時の child 防御 close で safepoint 保存が完了しうるか | 低〜中 | U5。APPLY 進行中の engine 保存経路の前提（project dir・saver 登録）が満たされるかは未検証 | **保証に含めない**（一次経路 = TS の APPLY 前 save→close を S5 で pin）。防御経路は「ウィンドウが畳まれ ring が詰まらない」ことだけを child unit で確認 |
| 8 | ~~C-A の例外解釈（drop 時の close）~~ → **owner 確定済み（2026-08-28・§0.5）**。「対象の消滅」は例外・判定軸はインスタンスの生存。`enabled: false` は生存側（開いたまま・§4.8-(5)） | 確定 | —（解釈から確定事項へ昇格。§4.8-(5) の「DAW の deactivate と同じ」という位置づけのみ本書の判断） | 反証不要。enabled 側の挙動は W8 が pin する |
| 9 | close の宛先導出（TS 登記の現在 index）が APPLY 応答と直列で乖離しない | 中 | TS の per-key 直列化キュー（実装設計書 §3.4-(1)）が UI コマンドまで直列化するかは**未確認**。乖離しても W7/H4 で loud（wrong-window は構造的に不可能） | 実装時に applyRack キューと `ui()` 経路の直列関係を確認し、非直列なら「loud エラー → 再評価で解消」を S 系テストに 1 行追加 |

---

## 8. 実装順序（Codex 委譲の分割単位）

1. **transport.rs**: §4.3 codec + §4.1/4.4 の per-window 化 + P1-P14（**H2 の再現 fixture を
   最初に書く** — §7-1 の反証を先に済ませる）
2. **child**: §4.6-(1)(3)(4) token 携行・照合・採用 + §4.6-(2) 順序ゲート + H1-H6
3. **engine_wrap / respawn guard**: §4.5（route registry・binding・remap）+ W1-W10
4. **TS**: §4.7 + S1-S5
5. **gated E2E**: E2E-1（同名 2 枚）・E2E-2（シフト生存）
6. 各段で `npm test` / `cargo test` 全 green + 変異実証を報告に含める（プロジェクト規則）

検証（sandbox 外の実機 E2E）は main の担当（CLAUDE.md 工程表）。
