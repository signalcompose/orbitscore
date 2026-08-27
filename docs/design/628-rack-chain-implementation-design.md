# 設計書: ラック形エフェクトチェーンの実装（issue #628）

- 起案: Fable（設計担当・2026-08-27）
- 対象 issue: #628（ラック形チェーン: 削除・バイパス・複数 insert の統合モデル）
- 意味論の正本: `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` **SC.10**（2026-08-27 制定）
- 経緯・棄却案: `docs/design/628-effect-chain-model.md`（DAW リサーチ）
- 前提設計: `docs/design/625-effect-replacement-design.md`（差し替え・削除の機構。本書はその上に建てる）
- 実装担当への注意: **§4 決定事項は確定済みとして扱い、再設計しないこと。** 仕様から逸脱する
  必要が生じたら spec 側を先に更新する（§7 Stage 0）。§10 の owner 確認事項は**確認が取れるまで
  実装しない**（DSL 表面は owner 確認が要る — #625 の教訓）。

---

## 0. 調査で確認した現状（実ファイルで確認済み。未確認項目は明記）

### 0.1 ホスティングの現状

| | 現状 | 根拠 |
|---|---|---|
| 1 レシーバの insert 数 | 1（`maxLength` 既定 1・全 manager 上書きなし） | `effect-slot.ts:174`（`options.maxLength ?? 1`） |
| daemon | 1 bus = 1 child。`OutProcControl.bus_slots: HashMap<String, Weak<Mutex<ChildSlot>>>` + master の `child_slot` | `engine_wrap.rs:249-285` |
| child の形 | `--shm/--plugin/--plugin-id/--sample-rate/--state` で 1 プラグインを起動。audio ループは input slot → scratch → `process_block` → output slot | `orbit-vst3-effect-child/src/main.rs`・`outproc_effect.rs:411-437`（`spawn_effect_child`） |
| child binary | **format ごとに別 binary**（`orbit-clap-effect-child` / `orbit-vst3-effect-child`）。拡張子で選択（#552 `select_child_exe`） | `outproc_effect.rs:97-120` |
| host↔child 制御 | shm 内 command mailbox（`CMD_SAVE_STATE`=1 / `CMD_OPEN_UI`=2 / `CMD_CLOSE_UI`=3・arg 1024B・detail 256B）+ child→host event ring | `transport.rs:282-315`・`orbit-child-runtime/src/lib.rs:90-108`（`service_child_main`） |
| SharedRegion | audio ping-pong + event 窓 + `child_status`/`child_flags`。**magic/version 無し・サイズ検査のみ** | `transport.rs:171-…`・`:1761-1767` |
| 差し替え | #625 実装済み（in-place 建て直し・quiesce ack・`shutdown` latch・`EffectSlotEntry`） | `engine_wrap.rs:288-300`・#625 設計書 §2.1 |
| respawn | watchdog が同一 shm へ再 spawn。復元 state は `ChildSlot::Active.latest_state`（`Arc<Mutex<Option<PathBuf>>>`）経由 | `engine_wrap.rs:2147-2178`・`outproc_effect.rs:479-560` |
| state 保存 | `GetPluginState {role, bus}` → mailbox `CMD_SAVE_STATE`（child がファイルへ直接書く）。ファイル名は `[receiver, role, normalizedName, occurrence]` の base64url | `session.rs:1767-`・`daemon-client.ts:519-527`・`project-state-store.ts:37-48` |
| UI | `OpenPluginUI {target, index, windowTitle}` — **wire は既に index を持つ**。TS 側も `(receiver, index)` 揮発アドレス（effect は 1 始まり・`resolvePluginStateTarget`） | `daemon-client.ts:546-556`・`global.ts:861-880` |
| child の UI | `UiService` は **`window: Option<Box<dyn WindowHandle>>` = 1 枚固定** | `ui_service.rs:90-92` |

### 0.2 TS / パーサの現状

| | 現状 | 根拠 |
|---|---|---|
| 登記 | `EffectChainMap.chains: Map<K, PluginSlot[]>`（配列形はあるが常に長さ 1）。per-key 直列化キュー・uncertain-ensure・`remove()` あり | `effect-slot.ts` 全体 |
| 名前解決（メソッド位置） | S2 実装済み: 既知 DSL メソッド > 宣言済みミキサー名 > カタログ（`resolveChainDispatch`） | `signal-chain/dispatch.ts:62-112` |
| 名前解決（値の位置） | **未対応**。named arg の値は number/string/boolean/識別子 ref のみ（`parseNamedArgument`）。map 値は #409 で拒否 | `parse-statement.ts:862-903` |
| `var x = [...]` | **コード値（chord）束縛として確定的にパースされる**（§6 決定 #48） | `parse-statement.ts:131-134` |
| 引数位置の `[...]` | `ExpressionParser` が chord stack として解釈（文字列要素は想定外） | `parse-expression.ts:117, 909-` |
| respawn 台帳 | `rust-engine-player.ts` の `loadedPlugins`/`pluginActiveByKey`（bus 単位 1 件） | #625 設計書 §3.7（本書では行番号未確認） |
| カタログ補完 | `PLUGIN_ARG_RE = /\.(effect\|instrument)\(\s*"([^"\n]*)$/` — **単一行・`.effect("` 直後限定**。ラック配列内・複数行では発火しない（SC.10.10 規範 1 の退行点） | `plugin-catalog-completion.ts:39` |
| UI の DSL 表面 | `seq.ui([index][, open])`（#617・index 0=instrument / 1〜=effect・bus は `ui(1)`）— **SC.10.10 規範 2 が index 表面を撤回** | `INSTRUCTION_ORBITSCORE_DSL.md` PH.2c（L1284-） |
| メソッド形解決 | `resolveChainDispatch` が未知メソッドをカタログへ照合し `kind:'plugin'` を返す（S2）— **SC.10.9 が撤回** | `signal-chain/dispatch.ts:62-112` |

### 0.3 「1 child = 両フォーマット」の前例（不在証明ではなく実在証明）

`orbit-plugin-scan` は **`orbit-clap-host` と `orbit-vst3-host` を同一 binary にリンク済み**
（`orbit-plugin-scan/Cargo.toml:27,34`）。1 プロセスに両ホストを同居させることは既に日常運用
されている。effect child が format 別 binary なのは「clack を daemon にリンクしない」ためで
あって（`orbit-clap-effect-child/Cargo.toml:8`）、child 同士を分ける理由ではない。

### 0.4 未確認（設計はこれらに依存しない形にしてあるが、実装時に確認すること）

1. `PipelinedEffectHost::process_block` の内部（本設計は変更しない）。
2. `DaemonClient.request` の既定タイムアウト値（`daemon-client.ts:768` 付近に per-request
   timeout の仕組みはある）。ApplyEffectChain は N×ロードを含むため、**実装者は request
   タイムアウトが `CHILD_READY_TIMEOUT`（60s・#625 設計書 §7 Stage B 申し送り）× 段数を
   カバーするか確認すること**。
3. `CLAPTestEffect(mix: 0.5)` 形の**パラメータ設定**が現在実行時に何をするか（本設計の
   スコープ外に置いた — §3.6-(6)）。
4. 同一 child プロセス内で「audio スレッドが既存インスタンスを processing 中に、main
   スレッドで新インスタンスを load/activate」する動作の安定性（§9-1 で反証方法を定義）。

---

## 1. 完了条件（曖昧語なし・直列 v1）

以下がすべて満たされたとき done:

1. `kick.effect([A, B])` 形（配列リテラル・`var` 束縛ラック・文字列単発形）が
   master / seq / sum / aux の 4 経路で、**エンジン再起動なし・評価のみ**で N≥2 段の直列
   チェーンとして音になる。E2E は seq 経路でフル oracle、master 経路で最小 oracle（§6）。
2. チェーン編集（要素の追加・削除・enabled 切替・同名スペック差し替え）が
   **child プロセスの respawn なし**（= child PID 不変が E2E oracle）で反映され、
   **LCS で対応づいた要素は音を止めずに生き続ける**（SC.10.5 規範 2）。
3. 編集失敗（ロード失敗・state 保存失敗）時、**旧チェーンが無傷で鳴り続ける**
   （prepare-commit・§2.2）。復旧は再評価のみ。transport 断（結果不明）は uncertain →
   次評価が rebuild（§3.4-(6)）で収束する。
4. 削除される要素の state はアンロード前に自動保存され（既存ファイル名形式・
   `project-state-store.ts` 無変更）、同名要素を書き戻す再評価で復元される
   （`[plugin-state] restoring` ログ + 音の oracle で E2E 実証）。
5. 既存 `.orbs` の `effect("名前")` 単発形の可観測挙動（宣言・冪等再宣言・異 spec 後勝ち・
   state 復元・linkAudio ゲート）が保たれる（SC.10.3b）。`remove()` は即時撤去（SC.10.3c —
   語彙 3 セットから消え `Unknown chain method` になる）。メソッド形カタログ解決は撤去され、
   誘導診断だけが残る（SC.10.9・§3.5-(5)）。
6. #625 の失敗モード表（R1-R33）の各行が §5.5 の dispositon（存置 / 移設 / 退役）どおりに
   処理され、存置行のテストは無変更 green。instrument 差し替え（T1-T9 ほか）は無変更 green。
7. 新規テストは全行変異検証つき（§5 の「変異」列を実施し red→restore→green の実出力を
   PR に添付）。壊し方は最低 4 種（分岐反転 / 回数 / 順序 / 引数）を横断していること。
8. `cd rust && cargo clippy --all-targets --features outproc-effect,outproc-instrument`
   と `cargo test --features outproc-effect,outproc-instrument` と `npm test` が green。
9. spec 更新（§3.8）が実装**前**に完了している（Stage 0）。
10. **#626（effect 側）の解消**: watchdog に見捨てられた（fast-fail 打ち切り済み）状態で
    **同じラック宣言をもう一度評価すると再 attach が起き音が戻る**（rust unit D14 +
    E2E では crash 注入が困難なため unit で担保し、E2E は R28-E5 の復旧系で代表させる）。
11. **診断の同期（#610 の穴を広げない）**: §6 の E2E が評価するのと同一の新構文サンプルが
    拡張 diagnostics で issue 0 件（#610 が先行着地していれば同一コードパスなので自動成立）。
12. **列挙完全性（PR #629 の教訓 — 列挙漏れ 3 回・うち 1 回はレビュー 5 体を通過）**:
    §7 Stage 1 の「列挙コマンド一覧」を全て実行し、**コマンドと件数を PR 本文に記録**する。
    レビューは件数の照合から始める。
13. **標準プラグイン `Gain`（SC.10.8）**: `Gain(db: n)` が 3 カテゴリ混在チェーンの中で
    実機で鳴り（E2E R28-E1 の RMS 積 oracle）、パラメータ再評価が respawn なしで反映され
    （R28-E9）、state ファイルを一切生成せず（`states/` 監視 + T23）、カタログ不在でも
    解決される（T18 — カタログを引かない実証）。同梱: アプリの配布物に
    `std-plugins/Gain.clap` が含まれ、OS のプラグインディレクトリに何も置かない。
14. **補完のラック対応（SC.10.10 規範 1）**: ラック配列内・複数行・`layer` 入れ子・
    `plugin("` の各文脈で文字列カタログ補完が出る（U1-U3）+ 実機エディタで手動確認を
    PR 本文に記録。既存の `.effect("` 直後の補完は退行しない。
15. **Cmd+Click で UI（SC.10.10 規範 2）**: カタログ要素の文字列を Cmd+Click すると当該
    インスタンスの UI が開く（位置→path 解決は T26・実機手動確認を PR 本文に記録）。
    MCP `open_plugin_ui` は `chain_path` 指定で動く（R28-E10）。`ui(index)` 形は DSL から
    消えている（§10-1 の確認結果に従う）。

`layer`（並列）は**記法・AST・wire スキーマの予約のみ**が本スコープ（適用は stage 表記つき
明示エラー）。並列の完了条件は §7 末尾に別掲。

---

## 2. 採用する機構と却下案

### 2.1 child の集約形態: 新規 rack child 1 本（両フォーマット同居）

**採用**: 新 crate **`orbit-effect-rack-child`** — CLAP / VST3 の両ホストをリンクし、
**stage list（`Vec<Stage>`・Stage = Plugin{CLAP|VST3} | Gain）を直列に回す** 1 binary。
`--shm/--sample-rate/--chain <manifest.json>` で起動する。1 bus = 1 child のトポロジー・
shm レイアウト・`engaged`/quiesce/`shutdown` latch・watchdog はすべて #625 のまま。

**却下: format 別 child を「同 format 連続区間ごと」に直列接続する形** —
混在チェーン `[clap, vst3, clap]` が 3 child + shm 3 面になり、shm 往復が「format の
切り替わり回数」に比例する。機構 B（1 child が N プラグイン）を選んだ理由（往復が段数に
比例しない）が部分的に崩れる上、区間の分割・統合というチェーン編集と直交しない状態が増える。
両ホスト同居は §0.3 のとおり前例がある。

**却下: 既存 2 child binary の温存 + rack 専用 binary の追加（3 本体制）** —
単発 insert も「長さ 1 のラック」なので（§3.4-(1)）、旧 binary の経路は到達不能になる。
到達不能な経路を残すと watchdog/respawn/select_child_exe の分岐が残り続ける。Stage 1 で
旧 2 crate を退役する（gated テストの `ORBIT_EFFECT_CHILD_BIN` 直指定も rack child へ更新）。

**付随する改善（#590）**: child spawn 1 回には AppKit init 起因の**約 34ms の固定コスト**が
実測されている（#590）。機構 B は (a) spawn 回数が段数分の 1（1 レシーバ 1 child）になり、
(b) チェーン編集の主経路（§2.2 APPLY）は **spawn を一切伴わない**ため、このコストを払う
回数が構造的に減る。#590 自体（XPC 失敗の解消）は独立 issue のまま。

### 2.2 チェーン編集 = child 内 prepare-commit（`CMD_APPLY_CHAIN` 1 コマンド）

**採用**: チェーン編集は child プロセスを作り直さず、mailbox の新コマンド
**`CMD_APPLY_CHAIN`**（arg = plan manifest のファイルパス）で child 自身が実行する:

```
1. plan の load op を全て実行（新インスタンスを side で構築。旧 stage list は audio
   スレッドで処理継続中 = 音は途切れない）
   - どれか 1 つでも失敗 → 構築済みの新インスタンスを破棄して abort。旧チェーン無傷。
     応答 detail に failed index と原因を返す
2. drop 対象（旧にあって新に無い要素）の state を capture して指定パスへ書く
   - 書けなければ abort（新インスタンス破棄・旧チェーン無傷）— #625 決定 3
     「保存失敗 = 中止」と同じ側に倒す
3. 新 stage list を block 境界で 1 回だけ swap（audio スレッドは世代カウンタで検知）
4. 旧リストのうち drop されたインスタンスを main スレッドで deactivate・破棄
5. OK 応答
```

**帰結（重要）**: #625 で effect の失敗モデルは (ii) in-place 型（teardown 後失敗 = dry
縮退・差し替え窓 = dry 素通し）だった。それは **1 child = 1 プラグイン**で「プラグインの
交換 = プロセスの交換」だったからである。rack child ではプロセスが生き残るので、
**チェーン編集は (i) prepare-commit 型に昇格し、dry 窓そのものが消える**（編集中も旧
チェーンが鳴り続け、失敗すれば旧のまま）。(ii) 型と quiesce/teardown 機構が残るのは
「チェーン → 空」（child 退場）・stream 停止・crash respawn だけになる。spec の
「v1 の現在地」注記を Stage 0 で更新する（§3.8）。

**却下: per-index の逐次 wire コマンド列（LoadPluginAt / UnloadPluginAt / ReplacePluginAt）**
— 編集は複数 op の列になるため、(a) 途中失敗で「半分だけ編集されたチェーン」が確定し、
TS の登記と daemon の実態の突き合わせが op 単位で必要になる。(b) 配列への逐次操作は
index シフトを伴い、op の適用順序（降順削除→昇順挿入）という暗黙規約が生まれる。
(c) 「対応がついた要素は生かしたまま」（SC.10.5 規範 2）を per-op で保つには結局 child 側で
prepare-commit 相当が要る。1 評価 = 1 コマンド = 1 コミットに畳む方が、失敗モデルも
in-flight 直列化も #625 と同じ形（slot 単位のガード）で済む。
**ブリーフの「index 単位へ一般化」は plan の op（keep/load/drop が index を持つ）として
コマンドの内側で満たされる。**

**却下: TS が全編集を「teardown + 新チェーンで spawn」に落とす形** — 実装は最小だが、
編集のたびに全段が dry 窓を通り、対応要素の実行状態（リバーブテール等）も切れる。
SC.10.5 規範 2「音を止めず」に反する。ただしこの形は **uncertain 復旧と daemon respawn
replay の経路としては採用する**（§3.4-(6)・rebuild モード）。

### 2.3 🔴 失敗の巻き添え範囲（ブリーフ指定の設計判断 1）

**判断: 「1 child が落ちるとその bus のチェーン全体が落ちる」ことを受容する。
ただし、この受容は #626 の解消とセットである — watchdog に見捨てられた終端状態から
「同じ宣言の再評価」で必ず復旧できることを、本設計の APPLY の ensure 意味論（後述）で
保証する。緩和は (a) watchdog の全段 respawn、(b) crash 帰責 index の観測、
(c) その ensure 復旧、の 3 点。クラッシュ常習プラグインの自動隔離（auto-quarantine）は
v1 に入れない。**

前提として置く issue: **#626** — 現行（1 slot 1 child）でも、watchdog が child を諦めると
スロットは `Active` のまま残り、**同じ spec の再宣言は spec 一致だけを見て冪等 Ok を返す**
（child の生死を見ない）ため、音は dry のまま・エラーも出ない。**巻き添えの幅を 1 bus の
チェーンへ広げる本設計は、この「無言で復旧不能」を放置すると被害を N 倍にする。**
したがって受容の条件は #626 の effect 側をこの設計で塞ぐこと（instrument 側と tenant 統計の
引き継ぎ A-3 は #626 に残る — §11 の表）。

根拠:

1. **終端状態の運転規則は #625 と同一。** child crash → watchdog respawn → 連続 fast-fail
   5 回で respawn 停止 = その bus は dry（`MAX_CONSECUTIVE_FAST_RESPAWNS` =
   `outproc_effect.rs:70-77`）。rack 化で変わるのは幅（1 プラグイン → 1 チェーン）だけ。
2. **「同じ行の再評価」で必ず戻る（#626 の解消・現状からの改善）**: APPLY は毎評価
   必ず発行され（TS は空 diff でも短絡しない — §3.4-(2)）、daemon は Active slot の
   **child 健全性（`current_child_pid` / `measurement_invalid` / mailbox の
   `CMD_RESULT_CHILD_EXITED`）を検分し、不健全なら同一コマンド内で rebuild
   （teardown → 全段 spawn）へ倒す**（§3.3-(2)）。ライブ中の最も自然な復旧操作が
   構造的に効くようになる — 巻き添え幅の拡大と引き換えに、復旧保証は #625 より強くなる。
3. **復旧手段がラックそのものになった。** 犯人をチェーンから外す操作は「配列から 1 要素を
   消して再評価」であり、これは本設計が第一級で高速化する操作（respawn なしの編集）。
4. **transient crash の実損は「1 回の dry 窓」で済む。** respawn は保存済み state から全段を
   復元する（§3.3-(4)）。
5. auto-quarantine（respawn 時に犯人 index を無効化して残りを守る）は**ユーザー操作なしに
   音が変わる**挙動で、silent degrade の一種。診断だけ loud にして、判断は演奏者に返す。
   将来入れる場合も (b) の帰責観測が前提部品になるので、v1 の投資は無駄にならない。
   → follow-up issue として起票する（§10-4）。

緩和 (b) の実体: child は各 stage の `process` 呼び出し**直前**に shm の新 field
`active_stage_index: AtomicU32` へ index を store する（Relaxed・毎 block 毎 stage 1 store）。
watchdog は crash 検知時にこれを読んで「respawn: last active stage = k (<プラグイン名>)」を
stderr に出す。E2E/get_log から犯人が特定できる。

### 2.4 🔴 `engaged` の粒度（ブリーフ指定の設計判断 2）

**判断: `engaged` は bus 単位のまま一切変えない。`enabled: false` は child 内部の
per-stage `AtomicBool` で表現し、両者を別レイヤとして分離する。**

| フラグ | 層 | 意味 | 読み手 |
|---|---|---|---|
| `engaged`（既存・bus 単位） | daemon RT | 「この bus の信号を shm へ流すか」 | `OutProcEffectPostProcessor::process`（`outproc_effect.rs:365-367`） |
| `enabled`（新・stage 単位） | child | 「この stage を素通しするか」（SC.10.2 の単位元） | child audio ループ（stage スキップ） |

根拠: `engaged=false` は **shm 往復ごと消える**（transport に触らない）。per-index の
バイパスに流用すると「index 3 だけ外すために全段を外す」ことになり粒度が合わない。逆に
enabled を daemon 側で表現するには daemon が chain 内部の信号を段間で観測できる必要があり、
機構 B（child 内直列）ではそもそも段間の信号は daemon に存在しない。**「daemon は bus 単位、
チェーン内部は child 単位」という責務分割は機構 B の直接の帰結**であり、フラグの置き場も
それに従う。

`engaged` が false になるのは従来どおり: (i) child 不在（チェーン空）、(ii) teardown 窓、
(iii) 隔離。**全要素 `enabled: false` のチェーンでは engaged は true のまま**（child が全段
スキップして等価素通し）。shm 往復 1 回分のコストは残るが、v1 はこれを受容する
（enabled はライブの A/B 操作であり、頻繁に往復切替される。engaged と連動させると
再 attach 相当の状態遷移が絡んで failure surface が増える）。

### 2.5 標準プラグイン（SC.10.8・owner 確定 2026-08-27）— `Gain` は普通の CLAP プラグイン

> **改訂履歴**: 初稿は `gain(db:)` を「child 内蔵の gain stage（スカラー乗算）」として
> 設計していたが、owner 確定で **gain は言語の要素ではなく標準プラグイン**になった
> （SC.10.8 — 確定原則「engine に DSP を抱えない」に沿う）。child 内蔵 stage・
> 「プラグインを含まないラックはエラー」の v1 特例・予約語 `gain` は**すべて消えた**。

**採用**:

1. **`Gain` は同梱 CLAP プラグイン**（新 workspace crate `orbit-std-gain` が `.clap` bundle を
   ビルドし、child 実行ファイルの隣の `std-plugins/` ディレクトリへアプリが同梱する）。
   rack child にとっては**カタログのプラグインと同じ 1 stage** — 特別な処理経路を持たない。
   `[Gain(db: -6)]` はプラグイン 1 つの普通のラックで、child を普通に起こす。
2. **名前解決は言語の語彙**（SC.10.8 規範 4）: TS は静的な標準プラグインレジストリ
   （名前 → param 定義）だけを見て、**カタログを引かない**。wire / manifest には
   `{kind:"standard", name:"Gain", params:{db:-6}}` と**記号で**運び、**実ファイルパスへの
   解決は child が自分の exe の隣（`std-plugins/<name>.clap`・テストは
   `ORBIT_STD_PLUGIN_DIR` で上書き）で行う** — インストールレイアウトの知識を
   daemon/TS に置かず、respawn 時も manifest が記号のままで安定する。
3. **パラメータは DSL が正**（SC.10.8 規範 5-6）: 標準プラグインは UI も state ファイルも
   持たない。manifest / keep op が `params`（DSL の名前付き引数そのまま）を運び、child は
   **CLAP param 名 = DSL 引数名**の契約（両端とも 1st-party なので成立する）で param id に
   写して適用する。値の変更は keep op のパラメータ更新（再ロードしない）。
   **`ChainConfig` が最新 params を保持する**ので、crash respawn 後も更新後の値で戻る
   （state ファイルの代わりに config が真実）。
4. **state 系から除外**: 標準プラグイン要素は save_dropped・statePathFallback・
   GetPluginState の対象外（宛先に指定されたら loud エラー）。LCS の同一性トークンは
   **カテゴリ付き**（standard `Gain` ≠ カタログ `"Gain"` — SC.10.1 規範 3 の名前空間分離を
   登記層でも保つ）。

**根拠（child 内蔵 stage 案を捨てて良い理由**、単なる owner 指示の転記ではなく）: 内蔵
stage は「gain だけ」の特例で、2 つ目の標準エフェクト（filter 等）が来た瞬間に破綻する。
CLAP プラグインにすれば標準プラグインは**群として増やせて**、rack child の機構検証
（混在チェーン・prepare-commit・keep 更新）を標準プラグイン自身が通常使用で常時踏む
（SC.10.8 引用注の owner 判断と同じ向き）。engine/RT には引き続き一切触れない。

---

## 3. 詳細設計

### 3.1 child: `orbit-effect-rack-child`（新 crate）

**(1) 依存**: `orbit-clap-host` + `orbit-vst3-host` + `orbit-audio-sandbox` +
`orbit-child-runtime` + `serde_json`。daemon は引き続き clack-free（リンク境界は不変）。

**(2) chain manifest（JSON・spawn 時 `--chain` / APPLY 時 plan の共通語彙）**:

```json
{ "version": 1,
  "stages": [
    { "kind": "catalog", "path": "/…/Pro-C 2.vst3", "plugin_id": null,
      "state": "/…/xxx.state", "enabled": true },
    { "kind": "standard", "name": "Gain", "params": { "db": -10.0 }, "enabled": true },
    { "kind": "layer", "branches": [...] }   // 予約のみ。v1 の child は BAD_ARG で拒否
  ] }
```

format は path の拡張子から child が判定する（`select_child_exe` と同じ判定基準を
child 内の「stage 構築時の host 選択」へ移す）。**format という語は manifest に持たせない**
（CAP.6-1: 上位は形式分岐を持たない。判定材料は path だけで足りる）。
`standard` stage は child が **自 exe の隣の `std-plugins/<name>.clap`**
（`ORBIT_STD_PLUGIN_DIR` で上書き可）へ解決してロードし、`params` を CLAP param 名一致で
適用する（§2.5）。`standard` は名前空間であって format の露出ではない（実体が CLAP なのは
child 内部の知識）。

**(3) 起動**: manifest の全 stage を順に構築 → 全成功で `publish_child_ready`
（`child_flags` の HAS_AUDIO_INPUT は「いずれかの plugin stage が audio input を持つ」の OR）。
1 つでも失敗したら `CHILD_STATUS_LOAD_FAILED` + stderr に index と原因（READY を出さない）。

**(4) audio ループ**: 現行 child の「input→scratch→process→output」の process 部を
stage list の直列走査に置き換える:

```
for (i, stage) in stages:                       // stage = ロード済みプラグイン
    region.active_stage_index.store(i)          //   （catalog / standard の区別は構築時のみ）
    if !stage.enabled → skip                    // SC.10.2: 直列の単位元 = 素通し
    stage.host.process_block(scratch)           // 失敗は per-stage error count 加算・dry 続行
```

パラメータ更新（standard の keep op）は main スレッドが CLAP param 経由で適用する
（audio ループに分岐を足さない — param 適用は各 host 実装の既存経路）。

stage list の差し替えは **generation 付き AtomicPtr の 1 回 swap**: main スレッドが新
`Box<StageList>` を publish → audio スレッドが block 境界で検知して交換し、**旧リストを
retire スロットへ返す**（audio スレッドで drop しない — プラグイン破棄を audio 側で
走らせない）。main は retire を回収してから破棄する。

**(5) mailbox コマンド（新設 4 種・既存 3 種は instrument child と共有のため番号温存）**:

| 定数 | arg | 応答 |
|---|---|---|
| `CMD_APPLY_CHAIN = 4` | plan manifest のパス | OK / `CMD_RESULT_PLUGIN_ERROR` + detail（failed index・原因） |
| `CMD_SAVE_STATE_AT = 5` | JSON `{"index": n, "path": "…"}` | 既存 SAVE_STATE と同じ（bytes 数） |
| `CMD_OPEN_UI_AT = 6` | JSON `{"index": n, "title": "…"}` | 既存 OPEN_UI と同じ |
| `CMD_CLOSE_UI_AT = 7` | JSON `{"index": n}` | 既存 CLOSE_UI と同じ |

plan manifest は (2) の stages に **op を注釈した形**:
`{"op":"keep","prev_index":k,"enabled":…,"params":…}` / `{"op":"load", …(2)の stage 形}` を
新チェーン順に並べ、`"save_dropped": [{"prev_index": j, "path": "…"}]` を添える
（standard 要素は state を持たないので save_dropped に**現れない** — daemon が弾く）。
`prev_index` は**適用前チェーンの index**なのでシフトの曖昧さが無い。keep の `params` は
standard 要素のパラメータ更新（catalog 要素の params は #522 スコープのまま）。

**(6) UI**: `UiService` を「index → main-thread handle」のレジストリに一般化する。
**同時に開ける UI は child あたり 1 枚**（現行の `window: Option<…>` 前提を維持）。
別 index の open 要求は「close してから」の明示エラー。APPLY で drop される stage の UI が
開いていた場合、TS が事前に close する（§3.4-(5)）ため child 側では防御的に close するだけ。
**standard stage への open は `CMD_RESULT_BAD_ARG`**（SC.10.8 規範 5: UI を持たない —
文言は「parameters live in the DSL」を含める）。

**(7) SharedRegion 追加 field**: `active_stage_index: AtomicU32` を**構造体末尾**に追加
（既存 field のオフセット不変）。magic/version が無いため（§0.1）、新旧 binary 混在時の
検出はサイズ検査に依存する — daemon と child は同一ビルドで配布される前提を維持し、
gated テストの `ORBIT_EFFECT_CHILD_BIN` 直指定も同時更新する。

### 3.2 daemon: wire（session.rs / protocol）

**(1) `ApplyEffectChain`（新コマンド）**:

```json
{ "role": "effect", "bus": "seq-bus-0"?,        // 省略 = master（既存規約）
  "mode": "diff" | "rebuild",
  "chain": [ {"op":"keep","prev_index":0,"enabled":true}
           , {"op":"load","kind":"catalog","path":"…","plugin_id":null,"state":"…","enabled":true}
           , {"op":"load","kind":"standard","name":"Gain","params":{"db":-10.0},"enabled":true}
           , {"op":"keep","prev_index":2,"enabled":true,"params":{"db":-6.0}} … ],
  "save_dropped": [ {"prev_index":1, "path":"…"} ] }
```

`kind` は §3.1-(2) の manifest と同一語彙（catalog / standard / layer 予約）。standard を
指す save_dropped・standard への `state` 指定は MALFORMED_REQUEST（state 系から除外 —
§2.5-4）。keep の `params` は standard 要素のみ有効。

応答: `{status:'applied', child_pid, dropped: [{prev_index, path, bytes_written}]}`。
失敗は既存 `ProtocolError` 形で `OUTPROC_EFFECT_RUNTIME` + failed index を本文に含む。
`role != 'effect'` は MALFORMED_REQUEST（instrument のチェーンは v1 に無い・SC.10.6 は
layer のみで後続）。

**(2) `ReplacePlugin (role='effect')` と `UnloadPlugin` の退役**: どちらも
ApplyEffectChain の部分集合になる（単発差し替え = `[{op:load}]` + save_dropped、
remove = `chain: []`）。session は role='effect' の ReplacePlugin と UnloadPlugin を
「superseded by ApplyEffectChain (#628)」の明示エラーに戻し、`protocol-types.ts` /
`ENGINE_DAEMON_PROTOCOL.md` を同時更新する。instrument の ReplacePlugin は無変更。
到達不能な二重機構を残さない（#625 決定 7 と同じ判断）。

**(3) `GetPluginState` / `OpenPluginUI` / `ClosePluginUI` / `AckUiSafepoint`**:
params に **`chain_path`（0 始まりの整数配列・v1 は長さ ≤1・省略時 `[0]`）** を追加する。
配列にするのは SC.10.10 の根拠（入れ子では位置が 1 次元 index で指せない）を wire に先取り
するため — layer 実装時に wire を再設計しない。daemon は v1 で `len > 1` を stage 表記
エラーにし、先頭要素を flat index として `*_AT` mailbox コマンドへ透過する。
**`chain_path` が standard 要素を指す GetPluginState / OpenPluginUI は明示エラー**
（state もUI も持たない — §2.5-4）。旧 `index`（UIH.5 の 1 始まり）との写像は
daemon-client 1 箇所に集約する。

**(4) UI 起動経路（SC.10.10）**: DSL の `ui(index)` 表面が撤回されたため、UI open の
発火元は (a) **エディタの Cmd+Click**（§3.7c — 拡張が構文木位置から
`(receiver, chain_path)` を解決し、既存の拡張→engine 経路で open を発行）と
(b) **MCP `open_plugin_ui`**（引数を index から `chain_path` へ改める・LLM 用）の 2 つに
なる（§10-1 の結論次第で、無引数 `seq.ui()` = instrument UI が第 3 の発火元として残る）。
daemon 側の open/close/safepoint 機構は (3) の `chain_path` 化以外は無変更。

### 3.3 daemon: engine_wrap.rs

**(1) 権威 chain config**: `EffectSlotEntry`（#625 新設・`engine_wrap.rs:288-300`）に
`chain: Arc<Mutex<ChainConfig>>` を追加する。`ChainConfig = Vec<ChainStageConfig>`、
`ChainStageConfig = Catalog { path, plugin_id, latest_state, enabled } |
Standard { name, params, enabled }`。**standard の params は state ファイルの代わりに
この config が真実**（keep op の param 更新で書き換え、respawn manifest がそのまま運ぶ —
§2.5-3）。**control スレッドと watchdog だけが触る（RT は読まない）** — RT スレッドから
Mutex を取らない制約はそのまま満たす。

**(2) `apply_outproc_effect_chain(bus: Option<String>, plan, mode)`（新設）**:

```
0. control lock: slot 解決（None→child_slot / Some→bus_slots[bus]）・in-flight 重複ガード
   （既存 replacements_in_flight を流用）・entry.shutdown latch 検査（#625 手順 0 と同一）
1. slot 検分:
   - Active + mode=diff: 🔴 まず child 健全性を検分する（#626 の effect 側の解消）:
       `stats.current_child_pid == 0` または `measurement_invalid` が立っている Active は
       「watchdog に見捨てられた抜け殻」— **mode=rebuild と同じ経路へ倒す**（下の teardown
       → spawn。spawn する desired chain は plan の順序どおり、keep op は
       `ChainConfig[prev_index]` のスペック + latest_state・load op は plan のスペックで
       再構成する）。
       健全なら plan manifest を一時ファイルへ書き、mailbox CMD_APPLY_CHAIN。
       OK → ChainConfig を新チェーンへ更新（keep は旧 entry を引き継ぎ、load は新 entry）。
       PLUGIN_ERROR → Err（daemon 側は何も変えない。child が旧無傷を保証）。
       CMD_RESULT_CHILD_EXITED（transport.rs:734・mailbox 発行中に child 消滅を検知）→
       健全性検分と同じ rebuild 落ち。
       mailbox timeout → Err（uncertain。config も変えない — respawn は旧 config で
       走るのが正しい: APPLY は commit されていない）
   - Active + mode=rebuild: #625 の teardown（quiesce ack → detach → Empty）→ 下の spawn へ
   - Empty + plan に plugin あり: ChainConfig から --chain manifest を書いて spawn
       （load_outproc_plugin_impl の chain 版。READY 待ち・retryable/unrecoverable の
        分岐・engaged=true は #625 と同一）
   - Active/Empty + 新チェーンが空 `[]`（全要素がプラグインになったため空以外は常に child が要る）:
       #625 の unload と同じ teardown。engaged=false。bus_actives は触らない
   - Loading → Err "load already in progress" / Closed → Err OUTPROC_SLOT_CLOSED（従来どおり）
2. in-flight 解除（Drop ガード・成功失敗どちらでも）
```

**(3) 触らないもの**: quiesce ペア・`shutdown` latch・`clear_quiesce_unless_shutdown`・
`OutProcTeardownGuard`・`bus_actives` の意味論・BusPool 簿記。#625 の R27-R33 が守る不変
条件はすべて teardown/stream-stop 経路の性質であり、APPLY 経路は quiesce を**使わない**
（shm を reset しないので RT との並行問題が発生しない）。

**(4) watchdog respawn の一般化**: respawn 時の CLI を「spawn 時に固定した
`--plugin/--state`」から「**respawn 時点の `ChainConfig` から書き直した `--chain`
manifest**」へ変える。`latest_state` は per-stage 化して ChainConfig 内へ移す
（state 保存成功時に該当 stage の latest_state を更新 — 現行 `ChildSlot::Active.latest_state`
の一般化）。crash 検知時に §2.3-(b) の `active_stage_index` を読み、stderr 診断へ含める。

**(5) `save_outproc_plugin_state`**: `chain_path` を受けて `CMD_SAVE_STATE_AT` を発行する
形へ一般化（instrument 経路は無変更）。standard 要素を指す保存は明示エラー（D15）。
保存成功時に ChainConfig の該当 stage の latest_state を更新する。

### 3.4 TS: 登記・LCS・managers

**(1) 表現**: `EffectChainMap` に rack 用の入口 `applyRack(key, rack: RackSpec)` を追加する
（クラスは分割しない: per-key 直列化キュー・uncertain・`chainFor` 観測面は共用が正しく、
instrument の `declare()` は無変更で共存する）。登記要素を
`ChainElement = CatalogElement（PluginSlot & { enabled }）| StandardElement { name, params,
enabled }` に拡張。`maxLength` ガードは effect 経路で撤廃（instrument は 1 のまま）。
**文字列単発形 `effect("X")` は `applyRack(key, [X])` に脱糖する**（SC.10.3b で owner
確定済み）。4 manager（master / seq / sum / aux）の `effect()` は全てこの経路に乗る。
標準プラグインの名前・param 定義は**静的レジストリ**（v1 は `Gain { db }` のみ）で検証し、
未知の param 名・型は wire 発行前に loud エラー（カタログを一切引かない — SC.10.8 規範 4）。

**(2) LCS 差分（SC.10.5）**: 新旧の**識別子列**の LCS を取り、一意でない場合は前方一致
優先（規範 4）。識別子トークンは**カテゴリ付き** — カタログは `catalog:<normalizedName>`、
標準は `standard:<Name>`。SC.10.1 規範 3 の名前空間分離（`"Gain"` ≠ `Gain(...)`）を
対応づけ層でも保ち、カテゴリ違いの同名は決して対応しない。
🔴 **diff が空（全要素 keep・変更なし）でも ApplyEffectChain は必ず発行する** —
TS 側で短絡すると、daemon の健全性検分（§3.3-(2)・#626 の解消）に到達せず「同じ行の
再評価で復旧」が TS 層で潰れる。冪等性は daemon 側（健全な child への all-keep APPLY =
child 側 no-op）が保証する。

- 対応した catalog 要素: スペック（resolvedPath / pluginId / declaredStatePath）が同一なら
  **keep**（enabled の差分だけ op に載せる）。スペックが異なれば**同位置 replace**
  （= drop + load・identity は旧要素のものを引き継ぐ = #625 差し替えと同じ自動保存
  identity）。
- 対応した standard 要素: 常に **keep**（enabled / params の差分を op に載せる —
  SC.10.8 規範 6「差分ではパラメータ更新の対象」）。standard にスペック差は存在しない
  （名前がすべて）。
- 対応しない旧要素: **drop**。catalog は save_dropped に identity 由来の保存パスを添える。
  **standard は save_dropped に載せない**（state なし — 消えるだけ）。
- 対応しない新要素: **load**。catalog は statePathFallback（project.yaml）で state を解決して
  添える。standard は params をそのまま載せる。

**(3) 出現順のインスタンス固定（SC.10.5 規範 3）**: occurrence は**ロード時に割り当てて
以後不変**。新要素の occurrence は「その (receiver, normalizedName) で**生存中でない最小の
非負整数**」を位置昇順に割り当てる（消えた occurrence の再利用 = 再追加でその保存 state が
復元される、が SC.10.3「書き戻せば復元される」の実体）。**テキスト位置から数え直す実装を
書いてはならない**（変異検証 T6 が守る）。state ファイル名形式は無変更。
standard 要素も同じ規則で occurrence を持つ（LCS の一貫性のため）が、state 系に一切
使われない（identity が state ファイル名に変換されるのは catalog のみ）。

**(3b) state 登記と #568 の両立（コードで確認済み）**: #568（同名別パスの identity 衝突）が
変えるのは `project.yaml` の **`states:` の値**（`Record<string,string>` → fingerprint 併記の
オブジェクト・検証用で権威にしない）であり、**key 形式（`identityKey`）とファイル名
（`stateFileNameForIdentity`）ではない**。manifest の読み書きは
`project-state-store.ts` に閉じている（読み: `resolveRegisteredPluginStatePath` = `project-state-store.ts:122` /
書き: `ProjectStateStore.saveBody` = `:234` の 2 箇所のみ — `grep -n "manifest.states\[key\]"`
で実測）ので、**両立する**。
ただし本設計は書き手を 1 つ増やす: APPLY の drop は child 側で state ファイルを書くため、
TS には**登記専用 API `ProjectStateStore.registerSavedState(identity, relativePath,
bytesWritten, fingerprint: {resolvedPath, pluginId})`** を同モジュール内に新設する
（capture+登記を結合した既存 `save()` は UI close 等で存置）。fingerprint 引数は
**#568 着地前から受け取って捨てる**（登記値スキーマが変わった時にこの 1 箇所で書けるよう
呼び出し側の配管を先に済ませておく）。manifest 書き込みを applyRack 側に直書きしては
ならない（#568 の変更点が散る）。

**(4) 失敗ポリシーの再編**: APPLY は prepare-commit なので、**確定拒否
（DaemonProtocolError）では登記を温存する**（旧チェーンが daemon に残っていることを daemon
が保証する）— #625 の effect 方針 'forget-and-ensure' から instrument 型 'retain-on-reject'
への転回。transport 断（結果不明）は従来どおり登記を忘れて uncertain を立て、**次の評価は
mode='rebuild' の ApplyEffectChain**（teardown + 全段 spawn・state は project.yaml
fallback）で確定状態へ収束させる。

> なぜ rebuild か: uncertain 時に diff を送るには「daemon 側の現在チェーン」との対応づけが
> 必要で、それは daemon に LCS を複製することを意味する。LCS の二重実装は挙動差の温床
> （#623 型の不一致）。uncertain は transport 断でしか起きない稀な経路なので、そこでだけ
> dry 窓 1 回を払って単純さを買う。

**(5) UI セッションの identity 化**: `openPluginUiSessions` のキーを (receiver, index) から
**`instanceId`** へ変え、close/save 時に現在のチェーンから index を導出する。チェーン編集で
index がシフトしても保存 identity が壊れない（現行コメント「index を永続キーへ流用しない」
の徹底）。APPLY 前の beforeReplace 相当で、drop / replace 対象に開いている UI を close する
（#625 §3.5 の一般化・保存 → close → APPLY の順序は R15 と同じ）。

**(6) スコープ外（明示）**: **カタログ**要素の実パラメータ（`plugin("X", threshold: -18)`）
は本設計に含めない。catalog の予約引数は `enabled:` / `format:` / `vendor:` のみ受理し、
その他の named arg は「parameter setting is staged with #522」の stage 表記エラー。
**standard 要素の params は逆に v1 の本体**（SC.10.8 規範 5 — UI が無いので DSL が唯一の
操作面）。SC.5 規範 2（再評価 = パラメータ更新）の v1 実装範囲 = enabled（両カテゴリ）+
standard の params。

**(7) respawn replay（daemon プロセス死）**: `rust-engine-player.ts` の台帳を
「bus → 単一 plugin」から「receiver → RackSpec」へ一般化し、fresh daemon への replay は
`ApplyEffectChain(mode='rebuild')` を receiver ごとに 1 発。#625 申し送り 4「宣言済み bus へ
LoadPlugin を再送しない」は「fresh daemon にのみ rebuild」の形で維持する。

### 3.5 パーサ / interpreter: ラック値と値の位置の解決

**(1) 配列リテラルの汎用化**: `var x = [...]` は現在 chord 束縛に確定パースされる
（`parse-statement.ts:131`）。これを**汎用配列 AST（要素 = 文字列 / 数値 / 度数トークン /
識別子 ref / 呼び出し / 入れ子配列）を保持する束縛**へ変え、**chord か rack かの分類は
interpreter が行う**。分類規則:

- 要素に STRING / 呼び出し（`plugin()`/`layer()`/`chain()`/大文字始まりの標準プラグイン
  呼び出し）/ 入れ子配列が 1 つでもあれば rack（chord にこれらは出現しない）。
- 要素が数値・度数トークンのみなら chord（現行どおり）。
- **識別子のみの配列**（`[m7]` vs `[glue]`）は静的に決定できない — 評価時に識別子の束縛種
  （chord 変数 / rack 変数）を引いて分類する。混在（chord 変数と rack 変数が同居）は明示
  エラー。既存の chord テストが無変更 green であることを完了条件に含める（§5 T1）。

**(2) 引数位置**: `effect(<配列リテラル>)` / `effect(<識別子>)` /
`instrument(layer([...]))` を受理する。`parseNamedArgument` の値制限
（`parse-statement.ts:862-903`）は**予約引数の値としては現行のまま**（rack は位置引数）。

**(3) 値の位置の語彙（SC.10.1 規範 3 の 3 カテゴリ = 構文で分類・照合は分類の後）**:

| 形 | カテゴリ | 解釈 |
|---|---|---|
| `"文字列"` | **カタログ** | カタログ名 or パス。解決は適用時に既存 `resolveEffectSpec` |
| `plugin("名前", enabled:, format:, vendor:)` | **カタログ**（完全形） | 引数が要る時・`"Gain"` 等どんな名前でも文字列で必ず取れる |
| **大文字始まりの呼び出し** `Gain(db: n)` | **標準プラグイン** | 静的レジストリで解決（SC.10.8 規範 4・カタログを引かない）。未知の名前は「no standard plugin named X」の loud エラー — **カタログへフォールバックしない** |
| **小文字の呼び出し** `layer([...])` / `chain([...])` / `plugin(...)` | **構造・言語語彙** | 未知の小文字呼び出しは loud エラー（`gain(db:)` には「`Gain(db:)` — standard plugins are capitalized」の誘導を含める） |
| 裸の識別子 | rack 変数参照 | 大文字小文字を問わず変数参照のみ。呼び出しでない `Gain` は変数を探し、無ければ「did you mean `Gain(...)`?」 |
| 入れ子 `[...]` | 構造 | 直列チェーン（`chain` の糖衣）。直列直下の直列は平坦化（`[[A],[B]]` ≡ `[A,B]`・SC.10.1 規範 1「深さで意味を変えない」） |

カテゴリが構文（文字列 / 大文字呼び出し / 小文字呼び出し）で先に決まるため、
**名前の照合はカテゴリ内でしか起きない** — 標準とカタログの衝突は構造的に存在しない
（SC.10.1 規範 3）。初稿にあった「予約語とカタログの衝突 warn」は前提ごと消えた。
`layer` は AST・型・wire スキーマ（§3.1-(2) / §3.2-(1) の `kind:"layer"` 予約）まで作り、
適用時に「`layer` (parallel) is staged behind PDC (SC.10.11)」の stage 表記エラー。

**(3b) 🔴 #583 と同じクラスの穴を作らない（値の位置の解決規律）**: #583 は「文の対象が
暗黙優先（globals > sequences > mixer nodes）で**黙って**同名シーケンスに解決され、バスが
隠れる」穴である。値の位置の新設解決は次の規律で同じクラスを排除する:

1. **曖昧さは常に loud** — 沈黙の優先解決を 1 つも作らない。具体的に:
   未定義識別子 = エラー（「rack 変数が見つからない」を名指し）/ chord 変数と rack 変数の
   混在配列 = エラー / 未知の大文字呼び出し = 「no standard plugin named X」で**カタログへ
   フォールバックしない** / 未知の小文字呼び出し = エラー（`gain` → `Gain` 誘導つき）。
2. **カテゴリを構文で先に決める**（SC.10.1 規範 3）ことで、名前の照合はカテゴリ内に閉じ、
   優先チェーン（#583 型の穴の発生源）自体が存在しない。メソッド位置の動的解決を値の位置に
   持ち込まない。
3. **レシーバ解決（`drum.effect(...)` の `drum` が seq かバスか）は本設計で触らない** —
   #583 の本体はそのままで、悪化も改善もさせない（§11 の表）。#583 の修正が入ったら
   rack 経路も同じ診断文言に自然に乗る（effect() 入口は共通）。

**(4) 語彙セット**: `GLOBAL_DSL_METHODS` 等 3 セット（`runtime.ts:7-77`）から **`remove` を
削除する**（SC.10.3c・即時撤去 — 呼べば既存の `Unknown chain method` になる。専用の移行
文言は設けない）。`plugin`/`layer`/`chain` と標準プラグイン名は**メソッド語彙には足さない**
（値の位置専用。`gain` はメソッド位置では従来どおり sequence gain で、値の位置の `Gain` とは
別物 — 大文字小文字で分かれる）。

**(5) 🔴 メソッド形カタログ解決の撤回（SC.10.9）**: S2 で実装済みの「未知メソッド名 →
カタログ照合 → `kind:'plugin'`」（`resolveChainDispatch` = `dispatch.ts:62-112` と
`catalogEntriesForMethod` / `resolveChainName` の plugin 層）を**撤去**する。解決順は
「既知 DSL メソッド > 宣言済みミキサー名」の 2 層になる。撤去後の未知メソッド診断は、
名前がカタログ名の正規化形に一致する場合に限り
`Catalog plugins are written as strings (SC.10.9): use effect("FabFilter Pro-Q 3")` の
誘導を含める（#583 の loud 原則 — 黙って Unknown に落とさない。ここでのカタログ照合は
**診断のためだけ**で、解決には使わない）。`resolveCatalogMethodCandidates` の消費者は
列挙コマンド（§7）で洗い、言語サービス側の候補提示（SC.6 第 1 段）も文字列補完
（§3.7c）へ寄せる。

### 3.6 instrument（SC.10.6 の v1 範囲）

- `instrument(layer([...]))`: パース・型付けまで。適用は stage 表記エラー（PDC 後続）。
- **裸の配列に複数 instrument = 明示エラー**（SC.10.6 規範 1）を interpreter 検証で今回
  実装する。単要素配列 `instrument(["X"])` は `instrument("X")` と等価に受理。
- `PluginInstrumentManager` / instrument slot pool / ReplacePlugin(instrument) は無変更。

### 3.7 診断文言（新設・すべて実装が実際に投げる文言をテストのアンカーにする）

1. APPLY 失敗: `effect chain apply failed at index <k> (<name>): <原因>; the previous chain is kept`
2. layer: `layer() (parallel racks) is staged behind PDC (SC.10.11); v1 supports serial chains only`
3. 未知の標準プラグイン: `no standard plugin named "<Name>"; catalog plugins are written as strings: effect("<Name>")`
4. 小文字 `gain(...)`: `unknown rack word "gain"; the standard gain plugin is capitalized: Gain(db: -6)`
5. instrument 裸配列: `multiple instruments need layer([...]); a bare array is serial and instruments cannot be chained (SC.10.6)`
6. メソッド形（撤回後）: `Catalog plugins are written as strings (SC.10.9): use effect("<実名>")`（カタログ照合が付く条件は §3.5-(5)）
7. 標準プラグインへの UI open / state save: `standard plugins have no UI/state; parameters live in the DSL (SC.10.8)`

### 3.7b 拡張 diagnostics の同期（#610 の穴を新構文で広げない）

拡張の diagnostics は**エンジンパーサと別実装の正規表現ヒューリスティック**である
（`packages/vscode-extension/src/diagnostics-analysis.ts` — 実測。engine の `parseAudioDSL`
を使っていない）。#610 はまさに「diagnostics が受理・エンジンが拒否」の乖離の実害を記録
している。本設計は新構文（複数行の配列リテラル・`plugin()`/`Gain()`/`layer()` の値位置
呼び出し・`var x = ["…"]`）を足すので、**diagnostics 側の同期は本設計のスコープ**:

- **推奨順序: #610（診断経路をエンジンパーサへ一本化）を先に着地させる**。着地済みなら
  本設計の diagnostics 作業はゼロになる（同一コードパスだから）。
- #610 が先行しない場合、Stage 1 の完了条件に「SC.10.1 の全記法サンプル（§6 R28-E1〜E10 で
  評価するテキストと同一物）が diagnostics で issue 0 件」を含める（unit:
  `diagnostics-analysis` に新構文サンプルを食わせる）。**逆方向（diagnostics が拒否・
  エンジンが受理）が新構文で発生しないことが基準**。エンジンより厳しい診断は評価前に
  ユーザーを止める = 新機能が使えないのと同じ。

### 3.7c 挿す UX — 補完のラック対応と Cmd+Click（SC.10.10・Stage 1 スコープ）

**(1) カタログ補完のラック対応（SC.10.10 規範 1）**: 現行の検出は
`PLUGIN_ARG_RE = /\.(effect|instrument)\(\s*"…$/`（`plugin-catalog-completion.ts:39` —
**単一行・動詞直後限定**）で、ラックの配列内・複数行・`layer` 入れ子では発火しない =
**ラック形への移行でそのまま退行する**。regex を「文脈スキャナ」に置き換える:

- カーソルから**後方へ**走査し、(a) 未閉の `"` の中にいるか、(b) その外側の未閉括弧
  （`[` `(` の入れ子）を遡って `effect(` / `instrument(` / `plugin(` / `layer(` の
  いずれかに到達するか、を判定する。走査は有界（後方 N 行・既定 50）。
- 到達した動詞から role（effect / instrument）を決めて既存 `filterCatalogEntries` に渡す
  （部分文字列フィルタ・`insertText` の既存挙動は不変）。`plugin("` も補完対象に加える。
- 判定関数は現行どおり vscode-free の純関数に保ち、unit（§5 U1-U3）で網羅する。
- **標準プラグイン名は文字列補完に混ぜない**（文字列 = カタログの構文。`Gain` は
  値位置の識別子補完 — v1 では言語サービス第 2 段 #495 に委ね、ここではやらない）。

**(2) Cmd+Click で UI を開く（SC.10.10 規範 2）**: `ui(index)` 表面の撤回を受け、エディタが
UI 起動の主経路になる:

- **DocumentLinkProvider**（Cmd+Click の標準機構）で、ラック内・`effect()`/`instrument()`
  引数内の**カタログ要素の文字列リテラル**にリンクを張る。クリックで拡張内部コマンドが
  `(receiver, chain_path)` を解決し、既存の拡張→engine の UI open 経路（MCP と同じ実体）を
  呼ぶ。
- **位置 → path の解決はエンジンパーサで行う**（#610 と同じ「同一コードパス」方針）:
  ラックの AST ノードに source range（line/col — #608 でトークンに付与済み）を保持させ、
  拡張は `parseAudioDSL` の結果からクリック位置を包む要素と receiver を得る。
  正規表現の独自解釈を**作らない**。
- 解決した `(receiver, chain_path)` は**現在の登記と照合してから**発行する: 名前が登記と
  食い違う（クリック位置のテキストが未評価）場合は「re-evaluate first」の loud メッセージ。
  黙って別要素の UI を開かない（#583 の原則）。
- 標準プラグイン要素にはリンクを張らない（UI が無い — hover 等の案内は将来）。
- instrument の名前文字列にも同じリンクを張る（instrument UI の Cmd+Click 経路）。

**別 issue に切るもの（owner 確定）**: プラグイン一覧の **Quick Pick**（探索の入口）と
**カタログに無い名前の診断**（#610 と同じ場所）。本設計では扱わない。

### 3.8 spec 更新（Stage 0・実装より先）

1. `docs/core/INSTRUCTION_ORBITSCORE_DSL.md`: 🔴 **「エンジン内部は順序付きリストで実装済み・
   DSL 側のガード解放のみ」という記述は誤りなので削除・訂正する**（順序付きリストは TS の
   帳簿だけ。daemon は 1 bus 1 child — ブリーフで実測済み）。effect 節へ SC.10 の要約
   （ラック形・削除は配列から・enabled・LCS・標準プラグイン）を反映する。
2. `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` **PH.2c**: `ui([index][, open])` の index 表面
   撤回（SC.10.10 規範 2）を反映する。残す形は §10-1（新規 owner 確認）の結論に従う。
   **PC.3（カタログ補完）**へ「ラック配列内・入れ子でも発火」（SC.10.10 規範 1）を反映。
   メソッド形（正規化名呼び出し）に触れる記述があれば SC.10.9 の撤回を反映する
   （`grep -n "メソッド形\|正規化名" docs/core/INSTRUCTION_ORBITSCORE_DSL.md` で列挙）。
3. `SIGNAL_CHAIN_DSL_SPEC_v1.md` **SC.5「v1 の現在地」**: 失敗モデル 2 型の記述に
   「**#628 以降、effect チェーンの編集（追加・削除・差し替え・enabled・params）は (i)
   prepare-commit 型**（rack child 内の prepare→swap）。(ii) in-place 型が残るのは
   チェーン→空の teardown・stream 停止・crash respawn」を追記する。旧 (ii) 全面適用の
   記述のままだと spec に false な文が残る（#625 §3.9 と同じ理由）。あわせて同注記の
   「`remove("名前")`（規範6）を実装する（#625）」の記述へ SC.10.3c（撤去）の相互参照を
   付ける。
4. `docs/research/ENGINE_DAEMON_PROTOCOL.md`: ApplyEffectChain（standard 要素含む）追加・
   ReplacePlugin(effect) / UnloadPlugin の退役・GetPluginState / UI 系の `chain_path`・
   MCP `open_plugin_ui` の path 化。
5. **SC.10.6 規範 2 の note-off 規定は #606 と同じ条文に載せる**: core spec の note-off 規定
   （RUN 終端 / stop_engine の flush — #606 が実装を追跡中）へ「instrument ブランチの
   無効化・削除」を発火ケースとして**追記だけ**する。runtime 実装は layer とセット
   （v1 スコープ外）で、その時に #606 が作る flush 機構を発火点から呼ぶ形にする —
   note-off 配送機構を二重に作らない。

---

## 4. 決定事項一覧（19 項目）

| # | 決定 | 根拠 | 確信度 |
|---|---|---|---|
| 1 | child は新規 `orbit-effect-rack-child` 1 本（CLAP+VST3 同居・stage list） | §2.1。両ホスト同居の前例（plugin-scan）・shm 往復を段数非依存に保つ。標準 = CLAP なので混在ホストが通常使用で常時検証される（SC.10.8 引用注） | 高 |
| 2 | 編集 = child 内 prepare-commit（`CMD_APPLY_CHAIN` 1 コマンド） | §2.2。対応要素を「音を止めず」に保てる唯一の形。失敗 = 旧無傷 | 高 |
| 3 | effect の失敗モデルは編集経路で (i) prepare-commit 型へ昇格。(ii) は teardown/stream 停止/respawn に残る | §2.2 帰結。spec は Stage 0 で更新 | 高 |
| 4 | 巻き添え = bus チェーン全体、を受容（#626 の effect 側解消が前提条件）。緩和は respawn + crash 帰責 index + ensure 復旧。auto-quarantine は follow-up | §2.3。終端状態の運転規則は #625 と同一・復旧手段はラック編集そのもの | 中〜高 |
| 5 | `engaged` は bus 単位のまま。`enabled` は child 内 per-stage AtomicBool | §2.4。機構 B の責務分割の直接の帰結 | 高 |
| 6 | **標準プラグインは記号（`{standard, name, params}`）で運び、実パスへの解決は child が自 exe 隣の `std-plugins/` で行う** | §2.5-2。レイアウト知識を 1 箇所に・respawn manifest が記号のまま安定・CAP.6-1 維持 | 高 |
| 7 | wire = `ApplyEffectChain`（diff/rebuild 2 モード）。ReplacePlugin(effect)/UnloadPlugin は退役 | §3.2。1 評価 = 1 コミット。二重機構を残さない | 高 |
| 8 | uncertain 復旧と respawn replay は mode='rebuild'（全段建て直し） | §3.4-(4)(7)。LCS を daemon に複製しない | 高 |
| 9 | LCS は TS 側のみ・トークンはカテゴリ付き。catalog の同名スペック差は同位置 replace（identity 引き継ぎ）・standard は常に keep（params 更新） | §3.4-(2)。SC.10.5 の規範を単一実装に閉じ、SC.10.1 規範 3 の名前空間分離を登記層でも保つ | 高 |
| 10 | occurrence はロード時割り当てで不変。新規は「生存中でない最小値」を再利用（standard は identity のみ・state に使わない） | §3.4-(3)。再追加 = 保存 state の復元（SC.10.3）と両立。ファイル名形式不変 | 高 |
| 11 | 確定拒否は登記温存（retain-on-reject）へ転回。transport 断のみ forget+uncertain | §3.4-(4)。prepare-commit が旧残存を保証するため #625 の「常に忘れる」根拠が消えた | 高 |
| 12 | UI セッションは instanceId キー・同時 1 枚。起動は Cmd+Click（拡張）と MCP の 2 経路・宛先は `chain_path`（v1 長さ ≤1 の配列） | §3.1-(6)/§3.2-(4)/§3.7c。index シフトから保存 identity を守り、入れ子でも wire を再設計しない | 高 |
| 13 | 配列 AST は汎用化し chord/rack 分類は interpreter（識別子のみ配列は束縛種で決定） | §3.5-(1)。`[m7]`/`[glue]` は構文で区別不能 — 実在の文法制約 | 高 |
| 14 | layer / 入れ子は記法・型・wire 予約まで。適用は stage エラー。入れ子直列は平坦化 | §3.5-(3)。SC.10.11 の段階そのまま | 高 |
| 15 | 値位置の 3 カテゴリは構文で先に分類し、名前照合はカテゴリ内に閉じる。フォールバック（標準→カタログ等）は作らない | §3.5-(3)(3b)。SC.10.1 規範 3。優先チェーン（#583 型の穴の発生源）を構造的に排除 | 高 |
| 16 | 標準プラグインの param 契約は「CLAP param 名 = DSL 引数名」。値の真実は `ChainConfig`（state ファイル無し・respawn は config から復元） | §2.5-3。両端 1st-party で名前契約が成立。SC.10.8 規範 5-6 | 高 |
| 17 | メソッド形カタログ解決（S2 の `kind:'plugin'`）は撤去。未知メソッド診断にのみカタログ照合を残す（文字列形への誘導） | §3.5-(5)。SC.10.9。解決に使わず診断に使うのは #583 の loud 原則 | 高 |
| 18 | Cmd+Click の位置→path 解決はエンジンパーサの AST range で行い、登記と照合してから発行する | §3.7c-(2)。#610 の同一コードパス方針・#583 の「黙って別対象を開かない」 | 高 |
| 19 | カタログ補完は後方有界スキャナへ置換（regex の動詞直後限定を廃し、ラック配列・入れ子・`plugin("` で発火） | §3.7c-(1)。SC.10.10 規範 1 の退行防止 | 高 |

---

## 5. 失敗モード一覧 ↔ 受け入れ基準テスト（1:1 対応表）

新規 **59 件**（child C1-C14 / daemon D1-D15 / TS T1-T26 / 拡張 U1-U3 / E2E 1 行 = §6 の
10 シナリオ）。TS unit の置き場は `tests/core/effect-rack.spec.ts`（新設・T\*）、rust unit は
rack child crate 内 `mod tests`（C\*）と `engine_wrap.rs` `effect_rack_tests` mod（D\*）、
拡張 unit は `tests/vscode-extension/`（U\*・補完スキャナと link 解決は vscode-free 純関数）。**テストの無い失敗モード、対応する失敗モードの無いテストは
無い。** 変異は最低 4 種（分岐反転 / 回数 / 順序 / 引数）を表全体で横断している。

### 5.1 child（C\*・rack child の unit。プラグインを使わない行は合成 stage — add 定数 / mul 定数 — で書く）

| # | 失敗モード | 検出するテスト | 変異 |
|---|---|---|---|
| C1 | stage の適用順が宣言順でない（音が別物） | 合成 stage add(1.0)→mul(2.0) の出力 = (x+1)·2 を assert（可換でない組で順序が出力に出る） | stages を逆順に走査 → red |
| C2 | APPLY が commit 後に load 失敗し旧が消える | load 失敗 plan で: 応答 PLUGIN_ERROR + failed index、audio 出力が旧チェーンのまま、旧 stage インスタンス生存 | load を swap の後へ移す → red |
| C3 | abort 時に構築済み新インスタンスが leak | 失敗 plan 後の生存インスタンス数 = 旧チェーン数（drop counter で計数） | abort 経路の破棄を削除 → red |
| C4 | `enabled:false` が素通しにならない / 逆 | disabled stage 挟みで出力不変・enable 復帰で変化 | 分岐反転 → red |
| C5 | standard の param 更新（keep+params）が再ロードになる / 適用されない | 実 `Gain.clap` で keep+db 変更の APPLY 後、stage の構築世代カウンタ不変 + 出力ゲイン変化 | keep を drop+load に変える → red / param 適用削除 → red |
| C13 | standard 解決の断線（`std-plugins/` 不在・`ORBIT_STD_PLUGIN_DIR` 無視・param 名→id の写像誤り） | 解決純関数の unit（既定 = 自 exe 隣・env 上書き）+ 実 Gain で db param が名前契約で引ける | env 分岐削除 → red / 写像を先頭 param 固定へ → red |
| C14 | Gain の DSP が dB 契約から外れる | `Gain(db:-20)` で出力 = 入力 × 0.1（±誤差）・`db:0` で恒等 | 係数を線形値扱いへ → red |
| C6 | drop の state capture が swap の後（実行状態を失った後）に走る / 保存失敗でも続行 | 保存パス書き込み < swap の順序を計装 assert・保存失敗注入で abort + 旧無傷 | 順序入替 → red / エラー握りつぶし → red |
| C7 | 旧 stage list を audio スレッドで drop（プラグイン破棄が audio 側で走る） | retire 経由の破棄スレッド id を assert | audio 側 drop に変える → red |
| C8 | READY が全 stage ロード前に出る | 2 要素中 2 個目を失敗させ、`child_status` が READY にならず LOAD_FAILED | READY を先に publish → red |
| C9 | `active_stage_index` が更新されない（crash 帰責不能） | ブロック処理後の値 = 最終 stage index。store 削除 → red | store 削除 → red |
| C10 | `CMD_SAVE_STATE_AT` が index を無視して常に 0 番を保存 | 異なる state を持つ 2 合成 stage で index=1 の保存内容を検証 | index 無視（常に 0） → red |
| C11 | swap が block 途中に見える（torn chain） | 世代カウンタの検知を block 境界 1 箇所に限定する構造 + 「swap 直後の 1 block が旧か新か一意」の assert | 走査中に再読込する形へ変える → red |
| C12 | 混在フォーマットで片方の host 分岐が選ばれない | 拡張子 → host 選択の純関数 unit（.clap→CLAP/.vst3→VST3・大文字小文字） | 分岐入替 → red |

### 5.2 daemon（D\*・`engine_wrap.rs` fixture 注入方式は #625 の `effect_slot_wiring_tests` / sleep-child 方式を踏襲）

| # | 失敗モード | 検出するテスト | 変異 |
|---|---|---|---|
| D1 | master/bus の slot 混線（#625 R25 の APPLY 版） | bus=None が master slot・Some が bus_slots を対象化することを状態遷移で assert | 解決を入れ替え → red |
| D2 | Active への diff APPLY が child を作り直す（PID 交代 = 編集のたび dry 窓） | mailbox 経路が呼ばれ spawn 経路が呼ばれないこと + `current_child_pid` 不変 | diff を rebuild に落とす → red |
| D3 | 空チェーン APPLY で engaged が残る / bus_active が落ちる | teardown 後 engaged=false・`bus_actives[bus]`=true・slot=Empty | engaged clear 削除 → red / active.store(false) 追加 → red |
| D4 | spawn manifest が要素を落とす・順序を変える | Empty→spawn で書かれた manifest の stages が plan と同数・同順 | 1 要素 drop → red / 順序入替 → red |
| D5 | APPLY 失敗後に ChainConfig が新チェーンへ進む（respawn が失敗チェーンを復元） | PLUGIN_ERROR 応答注入 → config 不変・Err 透過 | 失敗でも config 更新 → red |
| D6 | mailbox timeout / child 死で in-flight が残留 | timeout 注入 → Err + 同 slot への次 APPLY が受理される | Drop ガード削除 → red |
| D7 | respawn が spawn 時 CLI を再利用（編集後チェーン・最新 state を無視） | APPLY→state 保存→child kill→respawn の manifest が最新 config + latest_state を含む | respawn を初期引数固定へ → red |
| D8 | 同一 slot への並行 APPLY | 既存 in-flight guard で 2 発目 Err（#625 R16 の APPLY 版） | guard 削除 → red |
| D9 | stream 停止と APPLY の交錯（#625 R27 の APPLY 版） | `shutdown=true` 先行で APPLY が Err "engine is stopping"・slot 無傷 | latch 検査削除 → red |
| D10 | `GetPluginState chain_path` が透過されない | `chain_path:[1]` 指定で `CMD_SAVE_STATE_AT` の arg JSON に index:1 | path 落とし → red |
| D11 | UI 系の chain_path 透過欠落 / path→flat index の写像誤り | OpenPluginUI `chain_path:[1]` → `CMD_OPEN_UI_AT` arg に index:1 | 変換削除（off-by-one） → red |
| D15 | standard 要素への state/UI 要求が黙って通る・`chain_path` len>1 が黙って先頭解釈 | standard を指す GetPluginState / OpenPluginUI → 明示エラー（§3.7 文言 7）・len>1 → stage 表記エラー | 検査削除 → red（save が発行される / 先頭 fallback） |
| D12 | 退役コマンドの黙殺（ReplacePlugin(effect)/UnloadPlugin が旧動作のまま生存） | session unit: 両者が "superseded by ApplyEffectChain" を返す | 旧分岐復活 → red |
| D13 | rebuild モードが teardown を飛ばして二重 child | Active+rebuild で旧 PID 消滅 → 新 PID（sleep-child fixture） | teardown 削除 → red |
| D14 | 抜け殻 Active への APPLY が冪等 Ok を返す（**#626 の effect 側**・無言で dry 継続） | `current_child_pid=0` / `measurement_invalid` を立てた Active fixture へ diff APPLY → rebuild 経路（teardown+spawn）に入り新 PID | 健全性検分を削除（spec 一致だけ見る）→ red |

### 5.3 TS（T\*）

| # | 失敗モード | 検出するテスト | 変異 |
|---|---|---|---|
| T1 | 配列 AST 汎用化で chord が壊れる | 既存 chord/pattern テスト全 green（変更差分がこれらを赤くしないことが検出条件）+ rack リテラル（文字列・plugin()・gain()・入れ子）のパース | — （既存 suite が検出器） |
| T2 | 識別子のみ配列の分類誤り | chord 変数→chord・rack 変数→rack・混在→明示エラー の 3 態 | 分類を先頭要素の構文だけで決める → red |
| T3 | ラックが参照になる（束縛書き換えが適用済みへ波及・SC.10.4 規範 3） | var 再束縛後、再評価前の receiver に APPLY が発行されない（`toHaveBeenCalledTimes`） | 束縛を参照共有に → red |
| T4 | ラック共有でインスタンス共有（SC.10.4 規範 2） | 同一 var を 2 receiver へ適用 → APPLY 2 回・登記が独立 | 登記共有 → red |
| T5 | LCS でなく位置対応（`[A,B,C]`→`[A,C]` で C が差し替え扱いになる） | drop 1 件（B の identity で save 1 回）+ keep 2 件を op 列で assert（引数まで） | LCS を index 対応に → red |
| T6 | occurrence をテキストから数え直す（SC.10.5 規範 3 の背景バグ） | `[A,A]` から先頭を消す → 残存要素の keep op が occurrence=1 のまま・state 宛先も 1 | 数え直し実装 → red |
| T7 | 新規要素の occurrence 割り当てが不定 | `[A#0,A#1]`→`[]`→`[A,A]` で 0,1 を位置昇順に再割り当て + fallback state 解決がその identity | 最大値+1 方式へ → red（再追加で state が戻らない） |
| T8 | 同名スペック差が keep 扱い（差し替わらない） | format 変更で同位置 replace op（drop+load・同 identity で save） | spec 比較削除 → red |
| T9 | enabled 切替が reload になる | enabled だけの再評価 → keep op 1 件・load 0 件（回数+引数） | keep→load 化 → red |
| T10 | 文字列単発形の脱糖漏れ（旧 declare 経路が残り二重機構） | `effect("B")` が applyRack([B]) を通ること・#625 の可観測挙動（冪等・後勝ち・復元）が新経路で保持 | 脱糖を外す → red |
| T11 | 空ラックで linkAudio ゲートが開く | `effect([])` 後も master ゲートが閉（`hasDeclared` 温存） | hasDeclared リセット → red |
| T12 | 確定拒否で登記を忘れる（旧チェーンと登記が乖離 → 次評価が全 load） | DaemonProtocolError 注入 → 登記温存 + 次の同一評価が diff を再送 | forget に戻す → red |
| T13 | transport 断後の収束欠落 | 非 protocol error 注入 → 登記 forget + uncertain + 次評価が mode='rebuild' | uncertain 削除 → red |
| T14 | UI セッションが index キーのまま（編集で保存 identity が別要素に化ける） | UI open → 前段を削除する APPLY → close 時の保存 identity が開いた要素のまま | index キーに戻す → red |
| T15 | respawn replay が先頭要素しか復元しない | fresh daemon への replay が全段 rebuild 1 発（mock daemon で op 列検証） | 先頭のみ replay → red |
| T16 | layer 適用が黙って直列化される | `layer([...])` 適用 → stage 表記エラー（文言アンカー）・APPLY 0 回 | エラー削除 → red |
| T17 | instrument 裸配列の複数が通る（SC.10.6 規範 1） | `instrument([A,B])` → 明示エラー・`instrument(["A"])` は単発等価 | 検証削除 → red |
| T18 | 3 カテゴリの構文分類が崩れる（標準がカタログへフォールバック / 文字列が標準を拾う） | カタログに "Gain" が実在する状態で: `Gain(db:)` = standard 要素・`"Gain"` = catalog 要素・`Fake(x:1)` = 「no standard plugin named "Fake"」で **wire 発行 0 回** | フォールバック追加 → red / カテゴリ判定を名前照合先行へ → red |
| T19 | 小文字 `gain(...)` が黙って何かに解決される | `gain(db:-6)` → `Gain(db:)` 誘導を含む loud エラー・APPLY 0 回 | 黙殺 or gain=Gain 別名化 → red |
| T20 | save_dropped のパスが state ファイル名規約から外れる（既存 state が読めなくなる） | drop の保存パス = `stateFileNameForIdentity(identity)` 準拠・登記は `ProjectStateStore.registerSavedState` 経由（applyRack が manifest を直書きしない = #568 両立の前提）・登記が APPLY 成功後 | パス生成を index ベースへ → red / manifest 直書きへ → red |
| T21 | 空 diff の短絡（**#626 復旧の TS 側での潰し**） | 同一ラックの再評価でも `ApplyEffectChain` が 1 回発行される（`toHaveBeenCalledTimes`） | 空 diff で return する短絡を足す → red |
| T22 | 拡張 diagnostics が新構文を拒否（#610 の逆方向・評価前にユーザーが止まる） | `diagnostics-analysis` unit: §6 と同一の新構文サンプルで issue 0 件 | 配列リテラル行を issue 化する分岐を足す → red |
| T23 | standard 要素が state 系へ混入 | standard を含むラックの drop / load で: save_dropped に standard 由来のエントリ 0 件・`statePathFallback` 呼び出しは catalog 要素の数だけ（`toHaveBeenCalledTimes` + 引数） | 除外を外す → red |
| T24 | メソッド形カタログ解決の残存（SC.10.9 撤回漏れ） | `kick.FabFilterProQ3()` → `effect("FabFilter Pro-Q 3")` への誘導文言エラー・宣言 0 回。ミキサー名メソッド・DSL メソッドは従来どおり | `kind:'plugin'` 分岐復活 → red |
| T25 | `remove` の語彙残存（SC.10.3c 撤去漏れ） | 3 語彙セットに `remove` 不在 + `global.remove("X")` が `Unknown chain method` | 語彙へ再追加 → red |
| T26 | Cmd+Click の位置→path 解決誤り（別要素の UI が開く #583 型） | link 解決 unit: 2 番目要素の文字列範囲 → `chain_path:[1]`・登記と名前不一致なら「re-evaluate first」で発行 0 回 | off-by-one → red / 照合削除 → red |
| U1 | 補完がラック内で発火しない（SC.10.10 規範 1 の退行） | 文脈スキャナ unit: 配列内・複数行・`layer` 入れ子・`plugin("` の 4 文脈で候補が出る + 現行の `.effect("` 直後も従来どおり | スキャナを旧 regex に戻す → red |
| U2 | 補完 role の取り違え | `instrument(["…` 文脈で instrument role のみ・`effect([` 文脈で effect role のみ（既存 `filterCatalogEntries` の引数検証） | verb 判定を固定値へ → red |
| U3 | 後方走査の非有界化（巨大ファイルで補完が刺さる） | 上限行数（50）より遠い `effect(` は文脈と見なさない | 上限撤廃で 51 行前を拾う → red |

### 5.4 E2E（1 行・実体は §6）

| # | 失敗モード | 検出するテスト |
|---|---|---|
| E | ユニット緑のまま実機で配線全長が断線（#528 型） | §6 の R28-E1〜E10（RMS 積 oracle + PID 不変 + get_log ERROR 計数 + 失敗注入 + 復元） |

### 5.5 #625 失敗モード表（R1-R33）の disposition

| 群 | disposition |
|---|---|
| R5/R7/R18/R25/R27〜R33（teardown・quiesce・latch・配線 wiring） | **存置・無変更 green**（teardown 経路は空チェーン化 / stream 停止 / rebuild で現役） |
| R1/R2/R6/R9/R16/R17（TS 差し替え発行・uncertain-ensure） | **移設**: applyRack 経路の等価テストへ書き換え（T10/T12/T13/D8 が対応） |
| R3/R4（ReplacePlugin(effect) wire） | **退役**: D12 が置換（退役文言を検証） |
| R8/R10〜R15/R22（保存・UI・linkAudio・respawn 台帳） | **移設**: T11/T14/T15/T20/C6 が一般化形で対応 |
| R19/R20/R21/R23（remove() 表面） | **退役**（SC.10.3c で owner 確定・即時撤去）: 削除は T5 の drop 経路が、語彙撤去は T25 が置換 |
| R24/R26 | **存置**（instrument 無変更 green / E2E は §6 が拡張） |

---

## 6. gated E2E の設計

`tests/e2e/orbitstudio-mcp-gated.spec.ts` へ 1 シナリオ追加（#618 E1-E6 / #625 R-E1〜R-E7 の
ハーネス・symlink fixture・カタログ一意 guard を再利用。**並行機構は新設しない**）。
oracle 素材: CLAP Test Effect（state = gain・0.25 登録）・VST3 gain oracle（1.0 系）・
**標準 `Gain`（本 PR の同梱プラグイン・dB 直指定）**。
**いずれも線形ゲインなので直列の順序は積に現れない — 順序の実証は C1（非可換な合成 stage の
unit）が担い、E2E は段数・要素単位の増減・PID 不変を担う**（役割分担を明記する）。

- **R28-E1**: `seq.effect([clapName, vst3Name, Gain(db: -20)])` + LOOP → 区間 RMS =
  dry × (0.25 × g_vst3 × 0.1)。**bus の effect child プロセスが 1 個**（rack child 1 PID）
  であること — カタログ CLAP + カタログ VST3 + 標準 CLAP の 3 種混在が 1 child に同居する
  実機証明
- **R28-E2**: LOOP 中に `[clapName, Gain(db: -20)]` へ再評価（vst3 を削除）→ RMS が
  ×g_vst3 分だけ戻る + **child PID 不変**（respawn していない = in-child 編集の実機証明）+
  ERROR 増 0
- **R28-E3**: `[clapName, vst3Name, Gain(db: -20)]` へ再追加 → RMS 復帰 +
  `[plugin-state] restoring` ログ（vst3 の state 復元）+ PID 不変
- **R28-E4**: `[plugin(clapName, enabled: false), vst3Name, Gain(db: -20)]` → RMS =
  dry × (g_vst3 × 0.1) + PID 不変
- **R28-E5**: 失敗注入 `[clapName, "/nonexistent/Issue628.vst3"]` → エラー surface +
  **RMS は編集前のまま**（旧チェーンが鳴り続ける = prepare-commit の実機証明）+ 再評価で復旧
- **R28-E6**: `effect([])` → RMS = dry 基準 + child PID 消滅 + routing 継続（ERROR 増 0）
- **R28-E7**: `var glue = [...]` を 2 seq へ適用 → 両方 wet・片方だけ再評価して差が出る
  （値であって参照でない）
- **R28-E8**: master 経路最小: `global.effect([A, B])` → 異チェーンへ編集 → ERROR 増 0 +
  PID 不変
- **R28-E9**: 標準プラグインのパラメータ更新: LOOP 中に `Gain(db: -20)` → `Gain(db: 0)` へ
  再評価 → RMS が ×10 戻る + PID 不変 + ERROR 増 0（keep+params の実機証明・state ファイル
  非生成 — `states/` に standard 由来のファイルが増えないこと）
- **R28-E10**: MCP `open_plugin_ui` の path 経路最小: `chain_path:[0]`（catalog 要素）で
  UI が開く（既存 #617 系のオラクル流用）・standard 要素を指すと明示エラー（§3.7 文言 7）
- `evaluate_orbitscore` の `ok` は証拠にしない。判定は capture WAV の区間 RMS と
  `get_log` の ERROR 計数・`[plugin-state]` 行。ゲート env 未設定時に skip されること。
  Cmd+Click と補完はエディタ内機能のため E2E 対象外（U1-U3 / T26 の unit が担う）。

---

## 7. 実装手順

> **段階分けの方針（owner 指示 2026-08-27・保守的に割らない）**: wire・child・TS は単独では
> 検証できない（実機で音が出るまで通らない）ため、**直列ラック capability 一式を 1 つの
> Stage（= 1 PR）に畳む**。境界を引くのは「リスクの性質が変わる場所」だけ:
> (i) spec/owner 確認（docs・実装より先）、(ii) PDC を要する並列（音の劣化クラス — 後続
> issue）。安全は PR の小ささではなく**完了条件（§1）・実機 E2E（§6）・変異検証（§5）・
> 列挙完全性（下記）**で担保する。

**Stage 0 — spec 更新 + owner 確認（docs のみ）**
§3.8 の 5 点。旧 owner 確認 3 件は **SC.10.3b / 3c / 8 で解決済み**（2026-08-27）。
残る確認は §10-1（`seq.ui()` 無引数形の存廃）のみ — **PH.2c の spec 反映（§3.8-2）が
これに依存する**ので、この Stage で確認を取る。検証: レビューのみ。

**Spike S — §9-1 の実測（PR にしない・数時間で捨てる前提）**
rack child の骨格だけ書き、実プラグイン 2 つで「片方 processing 中にもう片方を
load/activate」が安定するか実測する。不安定なら §9-1 のフォールバック（APPLY 中のみ
bypass）を Stage 1 の設計に反映して進む — **wire/TS 層はどちらでも変わらない**ので
Stage 1 の他作業をブロックしない。

**Stage 1 — 直列ラック capability 一式（1 PR）**

実装順序（PR 内のコミット順。各塊で該当 unit を書き、変異検証してから次へ）:

1. **`orbit-std-gain` crate（標準プラグイン基盤の初号）**: CLAP gain（param `db`）を
   `.clap` bundle にビルド（bundle 手順は `rust-spike/clap-test-effect` を手本にする —
   §9-6）。アプリ同梱（child exe 隣の `std-plugins/` へ配置するビルド/パッケージング手順）
2. `transport.rs`: `SharedRegion` 末尾 `active_stage_index` + `CMD_*` 4 定数
3. `orbit-effect-rack-child` crate（§3.1・standard 解決含む）+ unit C1〜C14
4. daemon: `ChainConfig` / `apply_outproc_effect_chain`（健全性検分・rebuild 落ち込み =
   §3.3-(2)）/ respawn manifest 化 / session `ApplyEffectChain`（standard 要素）+
   `chain_path` 透過 + 退役 2 コマンド（§3.2）+ unit D1〜D15
5. TS: 配列 AST 汎用化と分類・3 カテゴリ解決・メソッド形撤去（§3.5）・`applyRack` + LCS +
   occurrence 固定 + `registerSavedState` + 標準レジストリ（§3.4）・daemon-client /
   protocol-types / rust-engine-player（rebuild replay）・UI セッション instanceId 化・
   `remove()` 即時撤去・diagnostics 同期（§3.7b）+ unit T1〜T26 + 既存 suite 全 green
6. 拡張: 補完スキャナ（§3.7c-(1)）・Cmd+Click link provider（§3.7c-(2)）・MCP
   `open_plugin_ui` の path 化 + unit U1〜U3 / T26
7. gated E2E（§6）・旧 effect child 2 crate の退役
8. 実機ゲート: `npm run build:clean` → OrbitStudio 再起動 → `ORBITSCORE_MCP_PORT=39123` +
   `ORBIT_GATED_ORBITSTUDIO=1` で E2E → `evaluate_orbitscore` + `get_log` ERROR 0 確認
   （`ok` だけで判断しない）。**Cmd+Click と補完は実機のエディタで手動確認**し、結果を
   PR 本文に記録（unit U1-U3/T26 が自動面・実機は配線の目視）。E2E 出力は tail で切らず
   ファイルへ全文保存

検証コマンド（PR 完了時に全部回す）:
`cd rust && cargo clippy --all-targets --features outproc-effect,outproc-instrument && cargo test --features outproc-effect,outproc-instrument` /
`npm run build && npm test` / gated E2E

**🔴 列挙コマンド一覧（完了条件 §1-12。実行結果の件数を PR 本文に記録し、全箇所を
処置してからレビューを呼ぶ — PR #629 で列挙漏れが 3 回出た対策）**:

| 何の列挙 | コマンド | 全箇所に必要な処置 |
|---|---|---|
| `OutProcControl` 構築箇所 | `grep -n "OutProcControl {" rust/crates/orbit-audio-daemon/src/*.rs` | `ChainConfig` ハンドルを埋める（テスト注入は fixture 値） |
| 旧 effect child への参照 | `grep -rn "clap-effect-child\|vst3-effect-child" rust/ packages/ tests/ docs/ .github/` | rack child へ差し替え or 削除（退役の完全性） |
| `--plugin` CLI の組み立て | `grep -rn "\"--plugin\"" rust/crates/` | effect 経路は `--chain` 化・instrument 経路は無変更を確認 |
| mailbox `CMD_` 定数の消費側 | `grep -rn "CMD_APPLY_CHAIN\|CMD_SAVE_STATE_AT\|CMD_OPEN_UI_AT\|CMD_CLOSE_UI_AT" rust/` | host 側発行・child 側 service の両端が揃う |
| wire メソッド名 | `grep -rn "ApplyEffectChain\|UnloadPlugin\|ReplacePlugin" packages/engine/src rust/crates/orbit-audio-daemon/src docs/research/ENGINE_DAEMON_PROTOCOL.md` | protocol doc / protocol-types / session / daemon-client の 4 面一致 |
| DSL 語彙セット | `grep -n "remove" packages/engine/src/signal-chain/runtime.ts` | 3 セットすべてから削除済み（SC.10.3c） |
| `chain_path` の透過 | `grep -rn "chain_path" rust/crates/orbit-audio-daemon/src packages/engine/src` | GetPluginState / UI 3 コマンド + MCP `open_plugin_ui` の全てに存在 |
| state manifest の直接読み書き | `grep -rn "manifest.states" packages/engine/src` | `project-state-store.ts` 以外に 0 件（#568 両立の前提） |
| `EffectSlotLimitError` の消費 | `grep -rn "EffectSlotLimitError" packages/ tests/` | maxLength 撤廃後の残置/削除の判断が明示されている |
| メソッド形解決の残骸 | `grep -rn "resolveCatalogMethodCandidates\|catalogEntriesForMethod\|kind: 'plugin'" packages/engine/src packages/vscode-extension/src` | SC.10.9 撤回後、診断用の照合（§3.5-(5)）以外に 0 件 |
| `ui(` の DSL 表面 | `grep -rn "'ui'\|\.ui(" packages/engine/src tests/ docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | §10-1 の確認結果どおり（index 形は全廃） |
| 標準プラグインの参照 | `grep -rn "std-plugins\|orbit-std-gain\|ORBIT_STD_PLUGIN_DIR" rust/ packages/ tests/` | 解決規約（child 隣接 + env 上書き）が 1 実装に閉じている |
| 旧補完 regex | `grep -n "PLUGIN_ARG_RE" packages/vscode-extension/src` | 文脈スキャナへ置換済み（旧 regex の残骸 0 件） |

**Stage 2 —（後続 issue・本スコープ外）`layer` + PDC**:
layer 適用がエラーでなくなり、(i) 各 branch の報告 latency を child が集計して daemon へ
返す、(ii) branch 合算が位相整合する（コムフィルタが出ないことを逆相 oracle で実証）、
(iii) `[]` branch が素通し・`enabled:false` branch が無音（SC.10.2 の並列側）、
(iv) instrument ブランチ無効化の強制 note-off（#606 の flush 機構を呼ぶ — §3.8-5）を
E2E で実証。

---

## 8. 触ってはいけないもの

1. **`play()` 意味論**（全フェーズ共通規則 5）
2. **instrument 差し替え一式**（ReplacePlugin(instrument)・slot pool・T1-T9・
   `retain-on-reject` 現行値）
3. **RT コード**: `orbit-audio-native`（`InsertBusStage` / render 経路）と
   `OutProcEffectPostProcessor::process` — 本設計はどちらも読み手・書き手を変えない
   （新 field `active_stage_index` の読み手は watchdog = control スレッド）
4. **`bus_actives` の意味論**（一度 true にした bus を false へ戻さない）・BusPool 簿記
5. **quiesce / `shutdown` latch の #625 プロトコル**（`clear_quiesce_unless_shutdown` の
   SeqCst 指定を含む — R33 の構造的保証を弱めない）
6. **state ファイル名形式**（`stateFileNameForIdentity`）と project.yaml manifest 形式
7. `.serena/` `.git` `.env` 系。WORK_LOG.md はコミットごとに更新

---

## 9. 確信度が低い決定と反証方法

1. **同一 child 内で「audio 処理中に main スレッドで別インスタンスを load/activate」が
   安定するか** — 確信度: 中。DAW の常套（in-process ホスティングは皆これをやる）だが、
   本 codebase では child = 1 インスタンスが常だったため実績が無い。反証方法: Spike S
   （§7）で実測する（rack child に実プラグイン 2 つ・片方 processing 中にもう片方を load）。不安定なら「APPLY の load 中だけ audio ループを bypass に落とす」フォールバック
   （旧チェーンは止まるが dry にはならず、#625 の窓と同等）へ縮退できる — wire・TS 層は
   影響を受けない。
2. **APPLY 中の mailbox 占有**（load N 発で `CMD_*` が長時間 busy）— 確信度: 中。同一 slot の
   操作は TS per-key キューと daemon in-flight で直列化済みなので競合は「同 receiver への
   save/UI」だけ。反証方法: D6 の timeout 注入 + E2E の編集中 UI open。問題が出たら
   APPLY 応答を「受理 ack + 完了 event」の 2 段へ分ける（event ring は既存部材）。
3. **識別子のみ配列の分類（決定 13）が既存 chord 資産と衝突しないか** — 確信度: 中〜高。
   反証方法: T1（既存 chord suite 全 green を検出器にする）。壊れる場合は「rack 変数参照は
   `chain(glue)` の明示形のみ」へ縮退（構文追加 1 語で曖昧さゼロ）。
4. **shm field 追加のビルド混在リスク** — 確信度: 中〜高。magic/version が無いため、stale
   binary（旧レイアウト）との混在はサイズ検査でしか弾けない。末尾追加でオフセット互換を
   保つが、反証方法として Stage 1 で「旧サイズ shm を開いた新 child が確実に拒否される」
   unit を足す（`shm file too small` 経路の逆向き検査）。
5. **enabled 全 false 時に engaged を落とさない（§2.4）ことの CPU コスト** — 確信度: 高
   （shm 往復 1 回/block は既に常時払っているコスト）。反証方法: 気になる場合のみ
   `outproc_effect_bus_stats` の callback 時間で実測。正しさを速度と交換しない
   （memory: measure-before-trading）。
6. **`.clap` bundle のビルド・アプリ同梱の経路** — 確信度: 中（**未確認**:
   `rust-spike/clap-test-effect` の bundle 手順と、child バイナリを OrbitStudio.app へ
   配置しているパッケージングスクリプトを本設計では読んでいない）。反証方法: Stage 1 の
   コミット 1 でまず `orbit-std-gain` を単体ビルドし、gated E2E R28-E1 が同梱経路ごと
   検証する。手順が写せない場合も contract（child 隣の `std-plugins/`）は不変で、
   ビルド側の実現方法だけが変わる。
7. **「CLAP param 名 = DSL 引数名」契約の将来互換** — 確信度: 高（両端 1st-party）。
   ただし param 名を変えると古い楽譜が壊れるため、標準プラグインの param 名は
   **公開後は改名しない**規約を crate の doc に明記する（反証不要・規約で閉じる）。

---

## 10. owner 確認事項と未解決の疑問

**解決済み（2026-08-27 owner 確定・spec 反映済み）**:

- ~~文字列単発形の意味論~~ → **SC.10.3b**: `effect("B")` ≡ `effect(["B"])`（完全な像）。
  設計どおり採用。
- ~~`remove()` の撤去方法~~ → **SC.10.3c**: 即時撤去（移行エラーなし — 既存楽譜で未使用）。
  設計の推奨 (b) は却下・(a) で実装する（§3.5-(4)・T25）。
- ~~gain のみのラックの v1 エラー~~ → **SC.10.8**: `gain` は言語の要素ではなく標準プラグイン
  `Gain` になった。特例そのものが消滅（`[Gain(db:-6)]` は普通の 1 プラグインラック）。

**新規に確認が要る点**:

1. 🔴 **`seq.ui()` 無引数形の存廃**（DSL 表面・PH.2c）: SC.10.10 規範 2 は「`ui([index])` の
   **index 表面**は撤回」と定めたが、**無引数 `cb.ui()`（instrument の UI・#617）を残すか**は
   文面から一意に読めない。bus の `ui(1)` は index 形なので確定で撤去。判断材料:

   - **#617 に明記された設計理由は 2 点**（レシーバに直接生やす / 複数同時オープンを制限
     しない）で、**どちらも Cmd+Click で満たせる**（「書きながら開く」はむしろ、行を書いて
     評価する手順が要らない分 Cmd+Click の方が直接的）。この観点だけなら撤去して一本化が
     素直。
   - ただし **issue には書かれていない副次的性質**が表面から導かれる: `cb.ui()` は
     **テキストに残る**ので、ブロックを再評価すると開き直る — 「このセッションではこの
     パートの UI を常に開いておく」を**楽譜に書いておける**。これは Cmd+Click（一回性の
     ジェスチャ）では代替できない。この性質に価値を認めるかは owner にしか決められない。
   - **LLM 経路**: Cmd+Click は人間専用なので、`ui()` を撤去すると **LLM が UI を開く
     手段は MCP `open_plugin_ui` のみ**になる。機能上は困らない（MCP は維持 — SC.10.10
     規範 3）が、「**LLM も人間と同じ DSL 経路で駆動する**」という記録済み方針
     （memory: llm-drives-orbitstudio-through-dsl — API 直呼びは計測系の例外）とはズレる。
     UI open を「計測系と同種の例外」と整理するか、DSL 表面を残すかの判断材料になる。

   **推奨: 無引数 `cb.ui()` のみ存置（instrument 専用・引数は全廃）**。撤去一本化と迷うが、
   上記 2 点（テキスト常駐の副次的性質・LLM の DSL 経路）は残す側にだけ利があり、残す
   コストは「引数なし 1 形の維持」で小さい。
2. **auto-quarantine の follow-up 起票**（§2.3）: 「crash 帰責 index を使い、fast-fail
   停止時に犯人だけ enabled:false で respawn する」を別 issue に切る（実害 1 文:
   常習クラッシュプラグインが 1 つあると、そのバスのチェーン全体が恒久 dry になる）。
3. **未解決（実装中に確定・owner 確認不要）**: DaemonClient の request timeout が APPLY の
   最悪時間（load N 発）を覆うか（§0.4-2）。覆わない場合は per-request timeout の引き上げか
   §9-2 の 2 段応答化。
4. **別 issue（owner 確定済み・本設計のスコープ外）**: プラグイン一覧の Quick Pick /
   カタログに無い名前の診断（SC.10.10 引用注・§3.7c 末尾）。

---

## 11. 関連 open issue と、この設計との関係

| # | issue | 関係 | 本設計での扱い |
|---|---|---|---|
| #610 | 拡張 diagnostics がエンジンの拒否する構文を受理 | **先に片付けるのが望ましい（必須ではない）** | 新構文は診断乖離の面積を広げる。#610（エンジンパーサへの一本化）が先なら本設計の診断作業はゼロ。先行しない場合は §3.7b + T22 + 完了条件 11 で新構文分だけ同期する |
| #568 | state identity key が同名別パスで衝突 | **織り込む（両立性をコードで確認済み・順序制約なし）** | key 形式・ファイル名は #568 でも不変（変わるのは manifest の値）。manifest 読み書きが `project-state-store.ts` の 2 箇所に閉じていることを実測（§3.4-(3b)）。本設計は登記専用 API `registerSavedState` を**同モジュール内**に足し、fingerprint 引数を先に配管する — #568 は値スキーマの変更 1 箇所で着地できる |
| #626 | watchdog に見捨てられた child が同じ宣言で復旧できない（無言） | **effect 側は本設計が解消（巻き添え受容の前提条件）** | APPLY の ensure 意味論: TS は空 diff でも必ず発行（T21）・daemon は Active の child 健全性を検分し抜け殻なら rebuild（D14・§3.3-(2)）。instrument 側の同型バグと tenant 統計引き継ぎ（A-3）は #626 に残る — 片翼修正の非対称は issue 側に明記する |
| #583 | 文の対象が同名シーケンスへ黙って解決しバスが隠れる | **同じクラスの穴を新設しない（本体は触らない）** | 値の位置の解決は「曖昧 = loud・語彙 3 種に固定・沈黙の優先チェーンを作らない」（§3.5-(3b)）。レシーバ解決（#583 本体）は不変 — 悪化させず、#583 の修正が入れば rack 経路も同じ入口で恩恵を受ける |
| #606 | RUN 終端で note-off が届かない | **同じ条文に載せる（spec のみ・実装は Stage 2）** | SC.10.6 の「instrument ブランチ無効化 = 強制 note-off」を core spec の note-off 規定（#606 が実装追跡）へ発火ケースとして追記（§3.8-5）。flush 機構は #606 のものを layer 実装時に呼ぶ — 二重に作らない |
| #590 | child spawn ごとに AppKit init ~34ms | **改善される（副産物）** | 機構 B で spawn は 1 レシーバ 1 回・チェーン編集は spawn ゼロ（§2.1）。#590 本体（XPC 失敗）は独立のまま |
| #522 | SC.5 のライブ意味論（ブロック再評価・パラメータ更新） | **境界を明確化（本設計は実装しない）** | 単発形の意味論（§10-1）・プラグイン実パラメータ（§3.4-(6)）は #522 に委ねる。本設計の後は「1 レシーバ内のチェーン」は SC.10 で完結し、#522 に残るのは評価単位（ブロック）とパラメータ更新 |
| #623 | 重複プラグインの先勝ち/後勝ち不一致 | **触らない（#625 と同じ防御を維持）** | E2E setup のカタログ一意 guard を再利用（§6）。解決は #623 の owner 判断待ち。なお標準プラグインはカタログを引かないため、この不一致の影響を**構造的に受けない**（SC.10.8 規範 4） |
| （新規起票） | プラグイン一覧の Quick Pick / カタログに無い名前の診断 | **本設計から切り出す（owner 確定）** | SC.10.10 引用注。後者は #610 と同じ場所（診断のエンジンパーサ一本化）に乗るのが自然 — 起票時に #610 へリンクする |
| （新規起票） | auto-quarantine（crash 常習 stage の隔離） | **本設計から切り出す（§2.3-5）** | 前提部品（crash 帰責 index）は本設計が実装済みにする |

## Appendix: 根拠として参照した主な実ファイル位置

- spec: `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.1/SC.3/SC.5/SC.10 全節
- TS: `effect-slot.ts`（全読・`:174` maxLength / `:264-` declareBody / `:286-` issueReplacement）/
  `plugin-effect-manager.ts:1-71` / `project-state-store.ts:1-120`（`stateFileNameForIdentity`）/
  `signal-chain/runtime.ts:7-90` / `signal-chain/dispatch.ts:1-120` /
  `parse-statement.ts:100-175, 400-470, 740-903` / `parse-expression.ts:117, 909` /
  `global.ts:830-880` / `daemon-client.ts:519-600`
- Rust: `engine_wrap.rs:239-300`（OutProcControl / EffectSlotEntry）・`:2147-2200`
  （ChildSlot / ChildLaunch）/ `outproc_effect.rs:1-120, 280-560`
  （PostProcessor / spawn / supervisor）/ `orbit-vst3-effect-child/src/main.rs`（全読）/
  `orbit-child-runtime/src/lib.rs:88-130` / `ui_service.rs:90-92, 203-223` /
  `transport.rs:56-140, 171-320, 724-750, 1731-1767` / `session.rs:1390-1460, 1573, 1715, 1767` /
  `orbit-plugin-scan/Cargo.toml:27,34`（両ホスト同居の前例）
- 拡張: `plugin-catalog-completion.ts:1-60`（`PLUGIN_ARG_RE` = `:39`）/
  `diagnostics-analysis.ts:1-40`
- 仕様（2026-08-27 改訂後）: `SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.10.1-10.11（3b/3c/8/9/10 を
  全読）/ `INSTRUCTION_ORBITSCORE_DSL.md` PH.2c（L1284-）
- 設計: `docs/design/625-effect-replacement-design.md`（全読）/
  `docs/design/628-effect-chain-model.md`（全読・確定モデル §6-7）
