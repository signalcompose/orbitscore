# #474 プラグイン UI open/close — 実装設計（Fable 設計・2026-07-30・**v2**）

> **リポジトリへの永続化について（2026-07-31）**: 本書は `/private/tmp` にのみ存在していた。
> フェーズ P0〜P6 の定義・分割の根拠・§8 の設計判断 Q1〜Q8 がすべてこの1ファイルに載っており、
> tmp の掃除で消える位置にあった。owner の「先送りが負の遺産にならないか」という問いへの
> 点検で判明したため repo へ移した。**分割して別 issue にした機能は §8 Q4 を参照**。
>
> **owner 裁定の反映状況（2026-07-31 時点）**:
> Q1 = (b) 全 receiver へ一般化（確定）/ Q2 = (b) `dirty_epoch`（**spec 反映済み** `9dea05e`）/
> Q3 = objc2 系（P1 で導入済み）/ **Q4 = §8 の「別 issue に分割」は失効**（下記）/ Q5 = REPL メタ行を**足す**（承認）/
> Q6 = `<plugin name> — <receiver>[<index>]`（承認）/ Q7 = CAP 改訂済み（`9dea05e`）/
> Q8 = 合成判定を承認（統合 E2E は capture WAV のアサーションまで通すこと）
>
> 🔴 **§8 Q4 の「別 issue に分割する」は失効している。** owner が個別に裁定し、
> `docs/development/WORK_LOG.md`（commit `9dea05e`）に記録済み:
> **Show info / Reveal in Finder = 不要**（owner 裁定）/ **右クリック挿入 = 不要**
> （挿入トリガーは #522・#506 と同時設計。現行 `.effect("` 前提で作ると #522 で作り直しになる）/
> **階層ブラウズ = 補完 #495 で満たす** / **Rescan catalog = 3面すべて実装済み**
> （コマンドパレット / `editor/context` / MCP `rescan_plugins`）。
> **つまり分割先の issue は不要。** 2026-07-31 に誤って #595 を作成し、同日クローズした。
>
> **実装時に効く既存資産**: `editor/context` メニューは既に存在する
> （`packages/vscode-extension/package.json:232`・`when: resourceExtname == .orbs`・
> `group: "orbitscore"`）。P5 の「Open Plugin UI」/「Close Plugin UI」は
> **メニューを新設せず既存グループに足す**形になる。

対象リポジトリ: `/Users/yamato/Src/proj_orbitscore/orbitscore`
設計者: Fable subagent（team lead 発注）
正本仕様: `docs/specs-v2/PLUGIN_UI_HOSTING_SPEC_v1.md`（UIH）/ `PROJECT_FILE_SPEC_v1.md`（PRJ）/
`PLUGIN_CAPABILITY_ABSTRACTION_v1.md`（CAP）

> **v2 改訂（owner 裁定 2026-07-30 の反映）**:
> 1. **#474 の検証範囲 = 「プラグイン UI が実際に開き、人間が触れる状態になること」まで**。
>    つまみ→音の変化はプラグイン内部の自明事項でありホストの検査対象ではない
> 2. **音色操作は2本足**: 人間 = GUI つまみ（→ state スナップショット = #577）、
>    人間+LLM = オートメーション（→ **DSL に残る**・#506 方向）。
>    **オートメーション値はスナップショットに保存しない — DSL が担保する**（owner 決着済み）
> 3. **computer-use は主経路から外す**（LLM 経路でも人間側検証道具でもない）
>
> これにより v1 §6 の「オラクル GUI へのつまみ・GUI 起点 state 変更を『UI 編集』と主張する
> フック・computer-use ティア調査」は不要または降格。§5b（新設）・§6・P6・§8 を改訂。

---

## 0. 要旨

**設計の大半はすでに UIH スペックが規範として確定している**（UIH.0〜UIH.9・owner 確定
2026-07-28）。本文書の仕事は「何を新しく決めるか」ではなく、

1. スペックを **6 フェーズの実装計画**（依存・受け入れ基準・検証方法つき）に落とすこと
2. スペックとコード実測の**乖離・空白**を列挙すること（→ §7 spec 更新一覧・§8 owner 確認事項）
3. **「ウィンドウが実際に開いた」を child の自己申告以外の経路で無人確認する**設計（§6）と、
   **#577 受け入れへの波及の判定**（§5b-3）を書くこと

**フェーズ列**（直列が基本・矢印 = ハード依存）:

```
P1 実行モデル変更（child main = Cocoa runloop / audio = 専用スレッド）
 → P2 イベント欄（evt リング）+ host 側ポンプ
 → P3 child の UI open/close（NSWindow 所有・クローズ状態機械）
 → P4 daemon/engine/MCP 配線（open_plugin_ui / close_plugin_ui・セーフポイント(b)）
 → P5 エディタ右クリック（テキスト位置 → (receiver, chain index) 解決）
 → P6 oracle 最小ウィンドウ + 無人 E2E（P3 完了後に oracle 側は並行着手可）
```

LLM の足（オートメーション DSL・#506）は**本計画のスコープ外**（§5b で線引き）。

---

## 1. 現状のコード実測(2026-07-30・本設計で確認した事実)

| 項目 | 実測 | 含意 |
|---|---|---|
| child 実行モデル | 4 child とも**単一スレッド spin loop**。audio 処理・`service_command_mailbox`・`ParentWatch`・`CONTROL_QUIT` 監視を同一ループで直列に回す（`orbit-vst3-instrument-child/src/main.rs:315-415`, `orbit-clap-effect-child/src/main.rs:112-171`） | UIH.0 の「現状」欄と一致。P1 は 4 child 全部に及ぶ |
| コマンドメールボックス | **実装済み**（#555/#562）。ただし `cmd_kind` は `CMD_SAVE_STATE=1` のみ（`orbit-audio-sandbox/src/transport.rs:244`）。`CommandMailboxHost` に単一 in-flight・exact-ack・generation 照合・`reset_after_child_exit` あり | UIH.2 の骨格は既設。OPEN_UI / CLOSE_UI の kind 追加と「ack=受理」型コマンドへの拡張が P3/P4 の仕事 |
| イベント欄（evt_*） | **未実装**（transport.rs に `evt_` 系フィールドなし） | UIH.2a は丸ごと P2 の新規実装 |
| CLAP state 配線 | **済み**。`orbit-clap-effect-child` は `--state` を読み `ClapEffectProcessor::load(state_bytes)`・`capture_state()` も CMD_SAVE_STATE で配線済み | **UIH.9 前提是正(2) は解消済み** → spec の当該行は事実の更新が必要 |
| vst3-effect-child バンドル | **済み**。`scripts/copy-daemon-bin.sh:85-98` が 4 child 全部を build & copy | **UIH.9 前提是正(1) も解消済み**。ただし「.vsix 内 bin 一覧の検証」が積まれているかは要確認（P0 で確認） |
| daemon プロトコル | JSON request/response + **event frame の push 経路あり**（`daemon-client.ts` が event を EventEmitter に dispatch） | UI_CLOSED → engine への通知に新チャネル不要。既存 event frame に載る |
| daemon → child の宛先 | `GetPluginState {role, bus?, instance?}` 形式で解決済み（`daemon-client.ts:407-427`） | OpenPluginUI / ClosePluginUI は**同じ宛先語彙**で追加できる |
| state 保存の全経路 | engine(TS) が sidecar パス決定 → daemon → `CommandMailboxHost` → child、atomic rename と `project.yaml` 登記は engine 側（`project-state-store.ts`） | **UIH の「host」は実際には daemon+engine の 2 プロセス**に分かれている。セーフポイント(b) の evt_ack 前進条件はこの跨ぎを含む（§4 P4 参照） |
| oracle 資産 | VST3: `orbit-vst3-gain-oracle` / `orbit-vst3-synth-oracle`。CLAP: `CLAPTestEffect.clap`（テストが自前 package）。**いずれも GUI なし** | P6 で gui 拡張を oracle に実装する |
| macOS binding 依存 | workspace に objc2 / cocoa 系 crate **なし**（core-foundation-sys のみ） | NSApplication/NSWindow 用に新規依存が要る（§8 Q3） |
| MCP | `save_plugin_state` / `open_plugin_ui` / `close_plugin_ui` は `packages/vscode-extension/src/mcp-server.ts` に登録済み | P4c で完了 |

---

## 2. 全体アーキテクチャ（確定スペックの再掲 + 層の割り当て）

```
[エディタ右クリック]                [LLM / MCP]
  テキスト位置 → (receiver, chain index) 解決      open_plugin_ui(receiver, index)
        └──────────────┬───────────────┘
                       ▼
   extension mcp-server / command  ──→  engine(TS)
      ・(receiver, index) を検証（chain 実在・期待名照合）
      ・daemon target (role, bus|instance) へ解決          【UIH.5 の層分離】
                       ▼
   daemon: OpenPluginUI / ClosePluginUI request
      ・CommandMailboxHost で OPEN_UI / CLOSE_UI を child へ投函
      ・evt リングをポンプ → UI_CLOSED / UI_CLOSED_DONE を event frame で engine へ push
                       ▼
   child（メイン = Cocoa runloop / audio = 専用スレッド）
      ・OPEN_UI: NSWindow 生成 → VST3 IPlugView attach / CLAP gui embed 【UIH.4】
      ・クローズ 3 経路 → 状態機械（Closed→Open→Closing→Closed）【UIH.4c】
      ・UI_CLOSED 投函 → host の保存完了 ack を待って解放 → UI_CLOSED_DONE
```

セーフポイント (b)（PRJ.3）は「UI_CLOSED 観測 → engine が既存の save+登記フローを実行 →
daemon が evt_ack 前進」で実現する。**#577 PR-A（停止時 snapshot）・PR-B（dirty 通知）と同じ
保存・登記コードに合流し、新しい永続化機構は作らない。**

---

## 3. フェーズ分割

### P0: 前提確認（半日・コード変更ほぼなし）

- UIH.9(1)(2) が解消済みであることの裏取りを完了させる:
  - `.vsix` 内 bin 一覧の検証テスト（UIH.9 が要求）が存在するか確認、なければ追加
  - `outproc_effect_vst3_gated` 等の gated テストを実機で回して green を確認
- **受け入れ基準**: 4 child すべてが bundled path から spawn 成功（実機）。spec UIH.9 の
  記述を実状に合わせて更新（§7-1）

### P1: 実行モデル変更 — child main を Cocoa runloop に（最重リスク・全 child 共通）

**内容**（UIH.0 / UIH.1 / CAP.5 に従う）:

- 新 crate `orbit-child-runtime`（4 child 共有）:
  - main: `NSApplication` 生成（activation policy = **Accessory**・Dock アイコンなし）、
    runloop 開始。数十 ms 周期のタイマーで `service_command_mailbox`・`ParentWatch`・
    `CONTROL_QUIT` を監視
  - audio: 専用スレッドへ退避（現行 spin loop をそのまま移設）。スレッド優先度は
    QoS user-interactive、必要なら `thread_policy_set`（time-constraint）。
    audio スレッドは `CONTROL_QUIT` の Relaxed load **のみ**を追加で見る（メールボックス・
    イベント欄には触れない = UIH.2 規律1）
  - 終了系: QUIT / 親死亡検知 → runloop 停止 → audio join → teardown
- `service_command_mailbox` 呼び出しを audio ループから**撤去**し main タイマーへ移す
- **UIH.3 の「演奏停止中のみ SAVE_STATE」MUST を撤廃**できる状態になる（spec 側の
  制約解除は実測確認後に行う・§7-2）

**受け入れ基準**:
- 既存全テスト green + `roundtrip_latency_gated` に退行なし（UIH.7 故障モード表の要求）
- 実機 E2E: 4 経路（clap/vst3 × effect/instrument）で音が出る・capture drops==0
- **演奏中の `save_plugin_state` が成功する**（新規 gated テスト。従来は禁止だった挙動の解禁を
  実測で確認）

**リスクと対策**: 小バッファ（64/32）は性能ゴール。audio スレッド化でレイテンシ退行が出たら
**この時点で設計を見直す**（UIH.7 に明記された停止条件）。P1 は単独 PR とし、後続を積む前に
実機確認を完了させる。

### P2: イベント欄（evt リング）+ host 側イベントポンプ

**内容**（UIH.2a を忠実に実装）:

- `transport.rs`: `EVT_SLOTS = 3`、`evt_seq` / `evt_kind[]` / `evt_arg[][]` / `evt_ack_seq`。
  publish/read の Release/Acquire 対、slot 再利用不変条件（`evt_ack_seq >= s - EVT_SLOTS`）、
  取りこぼし不可イベントの child 側再試行
- child 側: 投函 API（状態保持 + runloop 再試行）。host 側: `EventRingHost`
  （seq 順処理・追い越し禁止・ack 前進）。`reset_after_child_exit` に evt リングのリセットを追加
  （UIH.2a 故障表の respawn 行）
- **検証**: UIH.8 の変異検証リスト該当分（seq 順処理・未 ack slot 上書き・単一スロット化・
  Relaxed 化 → loom による in-process モデル検証。TSan は cross-process shm を追えないため）

**受け入れ基準**: 変異検証込みユニット + loom green。この時点で UI イベントの消費者はまだ
いない（P4 で接続）が、リングの正しさは単独で検証を完結させる。

**#577 PR-B との整合**: PR-B は「既存 shm に `dirty_epoch` 1語追加」で設計されている。
**推奨: STATE_DIRTY はリングに載せず `dirty_epoch`（合流カウンタ）で恒久化し、リングは
取りこぼし不可の UI_CLOSED / UI_CLOSED_DONE 専用とする**（§8 Q2・spec 改訂要）。
これで UIH.2a が STATE_DIRTY のために規定していた pending フラグ・in-flight 1 件制限・
「dirty の ack でフェーズ B が誤発火する」ハザードのクラスが**構造的に消える**。
owner が現行 spec（STATE_DIRTY もリング）を維持する判断ならそのまま実装する（実装可能・
規定は完備している）。

### P3: child の UI open/close（NSWindow 所有・クローズ状態機械）

**内容**（UIH.4 / UIH.4a / UIH.4b / UIH.4c）:

- 新 crate `orbit-child-ui`（4 child 共有・AppKit 依存はここに閉じ込める）:
  - **クローズ状態機械を AppKit 非依存の純 Rust モジュール**として実装
    （`Closed→Open→Closing→Closed`・3 経路合流・再入ガード・フェーズ A/B・
    「フェーズ B は UI_CLOSED 自身の seq 到達で開始」）。UIH.8 の変異検証 14 項目の大半は
    このモジュールのユニットテストで殺す（AppKit 呼び出しと evt 投函は trait で差し替え）
  - NSWindow 生成・delegate（`windowShouldClose` で NO → 状態機械へ・`windowWillClose` 禁止）・
    リサイズ応答（VST3 `IPlugFrame::resizeView`→`onSize` / CLAP `request_resize`）
- VST3: `createView("editor")` → `setFrame`（**attached より前**）→ `getSize` → NSWindow →
  `attached(nsview, "NSView")`。解放は `removed()` を親破棄より前に
- CLAP: `is_api_supported(cocoa, false)` false なら **loud 失敗**（UIH.4a・floating へ
  フォールバックしない）。`closed(was_destroyed)` は main へ marshal して経路③に合流
- `cmd_kind` に `CMD_OPEN_UI` / `CMD_CLOSE_UI` を追加:
  - OPEN_UI: main スレッド内で完結するため**完了時 ack**（結果コードで失敗を運ぶ）
  - CLOSE_UI: **受理時 ack**（UIH.2a ポリシー2。完了は UI_CLOSED_DONE イベント）
  - `Closing`/`Closed` 中の OPEN_UI = failure ack（"closing-in-progress"）、
    CLOSE_UI = 成功 ack（"already-closing"）— UIH.2a 故障表どおり

**受け入れ基準**: 状態機械の変異検証（UIH.8 リストの該当項目、特に「規律3 を忠実に守る host
モックで経路②が hang しないこと」）。実プラグイン（UI を持つ CLAP/VST3 各1）で
open→close が手元確認できること（この段階では手動確認可・無人化は P6）。

**新規依存**: `objc2` + `objc2-app-kit`（§8 Q3・owner 承認事項）。

### P4: daemon / engine / MCP 配線 + セーフポイント (b)

**内容**:

- daemon protocol: `OpenPluginUI` / `ClosePluginUI` request（宛先語彙は `GetPluginState` と
  同一: `{role, bus?, instance?}` + chain 由来の対象特定）。
- daemon: 各 child host に UI イベントポンプ（P2 の `EventRingHost` を既存のポーリングループへ
  接続）。`UI_CLOSED` / `UI_CLOSED_DONE` / respawn 由来のウィンドウ消失を **event frame** で
  engine へ push
- **セーフポイント (b) の 2 プロセス跨ぎ**（本フェーズの核心）:

  ```
  child: UI_CLOSED 投函
  daemon: 観測 → event frame "plugin-ui-closed" {target} を engine へ
  engine: 既存 save フロー実行（GetPluginState → sidecar → atomic rename → project.yaml 登記）
  engine: daemon へ AckUiSafepoint {target, evt_seq} request
  daemon: evt_ack_seq を前進（= UIH.2a ポリシー3 の「host 側処理の完結」）
  child: フェーズ B（解放）→ UI_CLOSED_DONE
  daemon → engine → MCP: close 完了
  ```

  - engine 停止・未接続・保存失敗時: daemon は**タイムアウトで evt_ack を進めない**。child 側の
    Closing タイムアウトが「保存なしでクローズ完遂 + UI_CLOSED_DONE(timeout)」で脱出する
    （UIH.2a 故障表）。保存失敗は登記を更新せず loud（PRJ.4）
  - `CONTROL_QUIT` 前に in-flight クローズ手続きを解決する（UIH.2a 故障表の最終行）—
    daemon の teardown 順序に組み込む
- MCP tool: `open_plugin_ui(receiver, index, expectedName?)` / `close_plugin_ui(receiver, index)`
  - close の完了判定 = **UI_CLOSED_DONE の受信**（ack ではない・UIH.4c 注記）。タイムアウトつき
  - 存在しない index / 未ロード / UI 非対応（CAP-UI-OPEN なし）はすべて **loud エラー**で、
    当該レシーバの有効 index 一覧（role・正規化名つき）を返す（UIH.5 規則3 — LLM の自己修正用）
  - **誤爆ガード**: 呼び出しに `expectedName`（正規化名）を任意で渡せるようにし、
    (receiver, index) の実体と不一致なら開かず loud エラー（「index がずれて別のプラグインの
    UI を開けた」silent failure の防止。エディタ経路は常に付与する）
- UIH.6 ライフサイクル: 停止時 = セーフポイント(c) の後に child ごと消える（既存）。
  respawn = 再オープンせず「respawn により UI が閉じた」を event frame → 拡張 output channel
  へ **loud 通知**
- REPL メタ行 `//#pluginUi <json>`（`//#savePluginState` と対称・実装コスト小。§8 Q5。
  当初案の `//#openPluginUi` / `//#closePluginUi` 2 本は、実装では JSON payload の
  `action: 'open' | 'close'` を持つ**単一メタ行に統合**した — P4c 実装済み）

**受け入れ基準**: MCP から open→close→登記→復元が通ること（実機・実プラグイン手動確認 +
oracle は P6 で無人化）。close 完了が DONE 受信であることの変異検証（ack で完了を名乗る変異
→ red）。

### P5: エディタ右クリック（人間の面）

**内容**（issue 本文 + owner 優先度確定コメント 2026-07-18: 本命 = Open UI のみ。
挿入系・階層ブラウズは**別 issue に分割**する — §8 Q4）:

- context menu（`editorLangId == orbitscore`）: **「Open Plugin UI」「Close Plugin UI」**
  - 🟢 **`editor/context` メニューは既に存在する**（実測 2026-07-31・
    `packages/vscode-extension/package.json:232`）。`when: resourceExtname == .orbs` /
    `group: "orbitscore"` で `orbitscore.rescanPlugins` が登録済み。
    **メニューを新設せず、この既存グループに2項目を足す**
  - 🔴 挿入系・階層ブラウズ・Show info / Reveal in Finder は **§8 Q4 の裁定により作らない**
- テキスト位置 → `(receiver, chain index)` 解決は**エディタ層に閉じる**（UIH.5）:
  - v1 は regex: カーソルが乗っている `.effect("...")` / `.instrument("...")` 呼び出しを検出、
    文頭のレシーバ識別子 + 同一文内のチェーン位置から index を算出
    （instrument = 0・effect は 1 始まり・UIH.5 の割り当て規則）
  - 解決した `(receiver, index, expectedName)` を P4 の同一経路へ渡す。engine 側の
    expectedName 照合が regex 誤りの安全網（不一致 = loud エラー + 現在のチェーン一覧提示）
  - #495 言語サービス導入時にこの regex を構文木ベースへ載せ替える（engine 以下は無変更 —
    UIH.5 の層分離の狙いどおり）
- 「ロード済みか」の事前検知は v1 では**しない**: メニューは常に出し、未ロードなら
  loud エラーを通知する（グレーアウトのための状態同期機構は作らない。loud 失敗原則と
  実装コストの均衡）

**受け入れ基準**: 実機で右クリック → UI が開く。カーソル位置が曖昧・プラグイン呼び出し外なら
説明つきエラー。engine 側照合の変異検証（expectedName 照合を外す変異 → red）。

### P6: oracle 最小ウィンドウ + 無人 E2E（§6 に詳細）

**内容**: oracle プラグイン（VST3 synth・CLAP test effect。必要なら CLAP synth）に
**最小 GUI（開くだけのウィンドウ・つまみ不要**・owner 裁定）を実装し、
gated E2E `tests/e2e/orbitstudio-mcp-gated.spec.ts` に受け入れシナリオを積む。

**受け入れ基準**（= #474 全体の完成条件・UIH.8 / owner 裁定で確定した範囲）:
- VST3 / CLAP の両方で「宣言 → **open_plugin_ui → ウィンドウが実在** → 閉じる（3 経路）→
  セーフポイント発火 → ウィンドウ消滅」が無人 green
- **ウィンドウの実在/消滅は child の自己申告と独立の経路（CGWindowList）の両方で assert**（§6）
- UI を開いている間・閉じる往復中の capture WAV に dropout なし（drops==0）
- クローズ 3 経路それぞれでセーフポイントちょうど 1 回（変異: 0 回・2 回で red）
- 「つまみ → 音の変化」の E2E は**作らない**（プラグイン内部の自明事項・検査対象外）

---

## 4. team lead の設計 5 論点への回答

### (1) GUI ホスティングの所有者・macOS runloop 要件

**child が開く設計で確定済み**（UIH.4・owner 確定）。runloop 要件は P1 の実行モデル変更で満たす:
`NSApplication` はプロセス先頭スレッド必須 → audio を専用スレッドへ退避し、main を runloop に
明け渡す。これは 4 child 全部に及ぶ変更なので**単独フェーズ（P1）として先に出荷し、レイテンシ
退行がないことを gated テストで確定させてから** UI 本体（P3）に進む。activation policy は
Accessory（Dock に出さない・ウィンドウ表示とキー入力は可能）。

### (2) daemon 経由の OpenUI/CloseUI IPC

**新チャネル不要**。既存の 3 経路に載る:
- host→child コマンド: 既存 `CommandMailboxHost`（#562）に kind を 2 つ追加
- child→host イベント: UIH.2a の evt リングを**新設**（P2）— これが唯一の新機構
- daemon→engine: 既存 event frame push

**PR-B との整合**: `dirty_epoch` 1 語追加の設計とは**競合しない**。推奨はむしろ
「STATE_DIRTY はリングに載せず dirty_epoch で恒久化」（P2 の項・§8 Q2）。この場合
リングは UI_CLOSED / UI_CLOSED_DONE 専用になり、spec が STATE_DIRTY のために規定した
合流規則が不要になって単純化する。

### (3) エディタ側 + LLM 対称

MCP `open_plugin_ui` / `close_plugin_ui` が正面（P4）。エディタ右クリックは
「テキスト位置 → (receiver, chain index) の解決だけ」を担う薄い層（P5・UIH.5 の層分離）。
両面は engine 内の同一関数に合流し、expectedName 照合・loud エラー（有効 index 一覧つき）で
LLM が自己修正できる形にする。

### (4) UIH.4 の 3 つの閉じる経路

P3 のクローズ状態機械が 3 経路を同一ハンドシェイクに合流させる（スペック完備・
実装は忠実に）。**状態機械を AppKit 非依存の純 Rust モジュールに切り出す**のが実装上の鍵で、
UIH.8 の変異検証リスト（特に「規律3 準拠 host モックで hang しない」= 最重要項目）を
ユニットで殺せる形にする。

### (5) E2E — §6 参照（最大の難所・正直に書く）

---

## 5. #577 との順序関係

- **PR-A（停止時 snapshot・PR #585）**: #474 と独立にマージ可。P6 で E2E の「manifest 手書き
  登記」を UI 操作に差し替える（PR-A の機構自体は無変更）
- **PR-B（dirty 通知）**: P1 完了で「演奏中の保存禁止」が外れ、PR-B の debounce checkpoint が
  本来の形（演奏中も保存）で実装可能になる。**PR-B は P1 の後に置くのが得**（先行させると
  停止中限定の暫定形を一度作って作り直すことになる）
- セーフポイント (b) は P4 で初めて存在し、PRJ.3 表の「(b) 未実装 → #474」が解消する

---

## 5b. 2本足アーキテクチャ・スコープの線引き・#577 への判定（v2 新設）

### 5b-1. 2本足の確定形（owner 決着済み・2026-07-30）

| 操作 | 使う人 | DSL に残るか | スナップショット |
|---|---|---|---|
| **GUI のつまみ**（#474 が開くウィンドウ） | **人間のみ** | 残らない | **必要** — これが #577 の存在理由 |
| **オートメーション**（プラグイン公開のパラメータ面） | **人間 + LLM** | **残る**（`.orbs`・#506 の DSL 表面） | **不要 — DSL が担保する** |

- LLM の第一級経路は **DSL を書いて評価させる**こと。MCP がパラメータを直接叩く設計にしない
  （「LLM も DSL 経由で使う」の既存原則のパラメータ層への適用）
- computer-use は主経路にしない（LLM 経路でもなく、人間側検証の道具としても owner は不採用）
- 「正本が2つ」問題（v1 §8 で owner 裁定候補としていた分岐）は**この決着で消滅**:
  オートメーション値は state に保存しない。ただし**実装上の含意**が1つ残る —
  プラグインの opaque state blob はパラメータ値も内包するため、復元順序は
  **「state スナップショット適用 → その上に DSL のオートメーション宣言を再適用」**
  （DSL 宣言が named パラメータについて常に勝つ・PRJ.6 の優先則と同型）。
  これは #506 側の設計事項として申し送る

### 5b-2. スコープの線引き（v2.1: prior art を一次確認して確定・**語彙を発明しない**）

オートメーションには既存の設計資産と issue 群がある（#506 / #460 / #522 / #525 /
#337 の成果物 = `POST_2.0_MIXER_DSL_DESIGN.html` §5）。一次確認した帰属:

| 作業 | 帰属 | 根拠（一次確認済み） |
|---|---|---|
| ネイティブ UI の open/close・3 閉路・セーフポイント(b) | **#474（本計画 P0〜P6）** | 人間専用の足（GUI） |
| オートメーション DSL 表面（`seq.PluginName(param: value)`・名前付きパラメータ） | **#506**（OPEN・当面「個別の数値指定」で十分 = owner） | #506 本文が「名前付きパラメータがそのまま **#460 オートメーションの入口**」と明記。**人間 + LLM の共用面**（LLM 専用ではない） |
| オートメーションの関数化（ramp / mod・変数で値が動く） | **#460**（OPEN・3層設計） | 設計正本 = `POST_2.0_MIXER_DSL_DESIGN.html` §5（RT 安全の3層分離・effect ハンドルがパラメータの reconciliation key）。owner の「変数・関数で自動的に変わる」= これ |
| **CLAP `params` 新設・VST3 `IEditController` のホスト API 化・param set の wire**（CAP-PARAM-LIST/GET/SET の実体） | **#522 スコープ2**（OPEN） | #522 本文が「パラメータを設定する経路が存在しない / VST3 は IEditController の土台あり、**CLAP は新設が要る**」と明記。**v1 で私が「別 issue 新設」と書いたのは誤り — 既に #522 が受け皿**。team lead の「PR-B とまとめるか」への回答: まとめない（PR-B = `clap_host_state`、params = 別拡張で #522 の領分） |
| dirty 通知（`mark_dirty` / `setDirty` 受け口） | **#577 PR-B** | 既定どおり |
| パラメータ MCP 面（列挙・観測） | #522（engine 受け口）+ #506（表面）。**設定系は DSL 経由が正**、列挙・読み取りは MCP でよい（LLM が「どの口があるか」を知る手段・CAP.6-4） | 対称設計 |
| per-part preset/params（マルチティンバー） | #525 | 隣接・本計画と独立 |

**#474 が負う唯一のオートメーション関連作業 = 境界の明記**:
「**スナップショット（PRJ）の対象は GUI 由来の編集だけ。オートメーション値は保存しない —
DSL が担保する**」を spec に規範として書く（§7 に行を追加済み）。復元順序
（state blob 適用 → DSL 宣言の再適用・§5b-1）は #506/#460 側へ申し送る。

### 5b-3. #577 への波及の判定（team lead の問いへの回答）

**問い**: PR #585（#577 PR-A）は #474 完了をもって「UI で音色を作る」受け入れを満たすと
言えるか。それとも実 UI 操作を経た記録の実機証明が別途要るか。

**判定: 合成で満たされる — ただし条件3つつき**（確信度: 中〜高）。

owner の裁定「つまみを動かせば音が変わるのは自明」の論理構造は
「**プラグイン内部の配線はプラグインの契約であり、ホストの検査対象ではない**」である。
同じ論理は「つまみの変更が `getState` の返す blob に映る」にも適用できる（これも
プラグイン内部のシリアライズ契約）。したがって受け入れ連鎖は:

```
ウィンドウが開く（#474 が証明）
→ 人間がつまみを回せる（自明・プラグイン内部）
→ 変更が getState に映る（自明・プラグイン内部の契約）
→ ホストが現在 state を捕捉・登記・復元する（#577 が証明）
→ 再起動で同じ音（#577 が証明）
```

となり、**ホストが検査すべき環はすべて #474 + #577 のテストで覆われる**。

**却下された「手書き state 登記」との違い**（ここが判定の核心）:
手書き登記は「**ホストの捕捉機構を通さずに登記簿を直接書く**」= ホスト側の検査対象である
捕捉・登記の環そのものをバイパスしていた。今回の合成は**すべての環をホストの実機構で
通し**、プラグイン内部の環だけを「検査対象外」とする。バイパスと免除は別物であり、
免除の線引きは owner 自身の「自明」裁定に一致する。**別の代替物には当たらない**と判定する。

**条件**（これが欠けると判定は崩れる）:

1. **#577 側の E2E で保存される state が、実 instance 内で発生した非デフォルト値であること**
   （デフォルト state の往復だけだと「現在 state でなくデフォルトを保存する」バグを
   検出できない。oracle の state 意味論 = 周波数オフセットで担保・E2E_HARNESS_SPEC §7）
2. **#474 のクローズセーフポイント統合 E2E が1本あること**（P6）: UI を開いて閉じたとき、
   その instance の現在 state（非デフォルト）が登記されること。人間の編集フローの
   ホスト側全長をこれが覆う
3. **Epic の最終受け入れとして、owner による実プラグイン1回のデモ**（#474 で Kontakt 等を
   開く → つまみを回す → 停止 → 再起動 → 同じ音）を推奨する。これは「テストに人間を
   介在させない」原則への違反ではない — テストループではなく、owner がプロダクトを使う
   行為そのもの。無人 E2E が覆えない「実プラグインの癖」への正直な残余対応でもある

**反証条件**: owner が「つまみ → getState 反映」を自明の範囲に含めない場合
（例: 明示イベントでしかシリアライズしないプラグインの存在を懸念する場合）、条件3の
一回デモを受け入れ必須に格上げすることで閉じる。判定に自信はあるが、受け入れ基準の
解釈権は owner にあるため、**この判定自体を owner に一度見せることを推奨**する。

---

## 6. 無人 E2E の設計（v2・検証対象 = 「ウィンドウが実在する状態にできたか」）

**owner 裁定により検証対象が確定した**: #474 が証明すべきは
「**人間が触れるようにプラグインを開いてあげられたか**」。つまみ操作・音の変化は
プラグイン内部の自明事項で検査対象外。したがって E2E の骨格は
**開く → 実在確認 → 3 経路で閉じる → セーフポイント → 消滅確認**。

### 6-1. 「開いた」の確認は二重経路（自己申告 + 独立証拠）

**child の「開いた」報告だけでは「報告したが実際には開いていない」を検出できない**
（#585 の `restoring` ログ = 「送信の証明 ≠ 適用の証明」と同型の穴）。二層にする:

| 層 | 手段 | 検出するもの |
|---|---|---|
| **内部報告**（LLM 対称の観測面） | OPEN_UI の完了 ack + child の UI 状態を daemon 経由で MCP から観測可能にする（`open_plugin_ui` の返却 + 状態照会）。**LLM が第一級ユーザーとして結果を検証できる**面はこちら | 配線の失敗（コマンド不達・ack 欠落） |
| **独立証拠**（E2E ゲートの物証） | `CGWindowListCopyWindowInfo` を叩く小ヘルパ（Rust・`kCGWindowOwnerPID` で child pid の on-screen window 数と bounds を確認。**Screen Recording 権限不要**の範囲 — タイトルは取らない。アプリ別権限付与も不要 = computer-use とは別物の素の OS API） | **「ack は返ったがウィンドウが無い」**（自己申告の嘘・attach 失敗の握り潰し・サイズ 0 ウィンドウ） |

E2E は**両方を assert**する。変異検証: child が NSWindow 生成をスキップして成功 ack を
返す変異 → 内部報告層は green のまま・CGWindowList 層だけが red になること（= 独立証拠が
実際に独立であることの証明)。

### 6-2. 3 つの閉じる経路の無人駆動

| 経路 | 駆動方法 | 備考 |
|---|---|---|
| ② CLOSE_UI コマンド | MCP `close_plugin_ui`（本番経路そのまま） | 主経路 |
| ① 閉じるボタン | env `ORBIT_UI_TEST_HOOKS=1` 限定の `CMD_UI_TEST_PERFORM_CLOSE` → main スレッドで `-[NSWindow performClose:]`。AppKit の実経路（`windowShouldClose` delegate）を通るので、delegate 以降の配線は人間クリックと同一 | クリック座標の合成はしない（脆さの源・不要） |
| ③ CLAP `closed()` | CLAP oracle が env 指定の遅延後に `clap_host_gui.closed(false)` を呼ぶ（プラグイン起点クローズの実駆動。oracle は自前資産なので正当なテスト実装） | VST3 に経路③は存在しない（CAP.2） |

### 6-3. アサーション一覧

| 観測 | 手段 |
|---|---|
| ウィンドウ実在 / 消滅 | §6-1 の二重経路 |
| クローズ完了の意味論 | MCP `close_plugin_ui` の返却が `UI_CLOSED_DONE` 起点（ack で返す変異 → hang/red） |
| セーフポイント 1 回 | 観測表面 `[plugin-state] ui-close snapshot ...` ログ 1 行（PRJ.9 と同型）+ 変異（0 回 / 2 回）で red |
| 保存内容が「現在 state」であること | oracle の state 意味論（周波数オフセット）を非デフォルト値にしておき、close 後の登記 → 再起動 → 周波数解析で一致（§5b-3 条件1・2。**「UI 編集の模擬」とは主張しない** — 検出対象は「現在 state でなくデフォルト/空を保存する」ホスト側バグ） |
| 演奏継続 | UI open 中・close 往復中の capture WAV drops==0 |
| respawn 時の挙動 | UI open 中に child kill → ウィンドウが復活**しない**こと（CGWindowList）+ loud 通知の存在（UIH.6） |

### 6-4. 残余（正直に）

1. **実プラグイン（Kontakt 等）の癖**（独自イベントループ・非標準リサイズ・スレッド不安全な
   getState）は oracle では出ない。補完: (a) 実プラグイン smoke gated テスト
   （open → close → crash なし・ウィンドウ実在まで。音色 assert なし・人間不要）を別枠で持つ、
   (b) 実機で観測した問題プラグインは UIH.7 の方針どおり個別記録、
   (c) **Epic 最終受け入れとして owner の実プラグイン 1 回デモ**（§5b-3 条件3）
2. CGWindowList はヘッドレス CI では動かない（実機ランナー前提）。既存 gated E2E と同じ
   実機ゲート運用に載せる
3. computer-use は設計から外した（owner 裁定）。デバッグ時に手元で screenshot する程度の
   道具としては禁止しないが、いかなるゲートにも据えない

---

## 7. spec 更新一覧（spec 先行の規約に基づき、実装フェーズごとに**先に** spec を直す）

| # | ファイル | 箇所 | 内容 | タイミング |
|---|---|---|---|---|
| 1 | PLUGIN_UI_HOSTING_SPEC_v1 | UIH.9 | 前提是正 (1)(2) の解消を事実として反映（bundle 済み・CLAP state 配線済み）。`.vsix` bin 検証の有無を確認して記載 | P0 |
| 2 | 同 | UIH.3 末尾の 🔴 MUST | 「audio 専用スレッド分離完了までは停止中のみ SAVE_STATE」→ P1 完了・実測確認後に制約解除の追記 | P1 完了時 |
| 3 | 同 | UIH.2a | STATE_DIRTY の運搬を evt リングから `dirty_epoch` 語へ変更（**owner 承認が要る改訂**・§8 Q2。却下なら現行どおり実装） | P2 前 |
| 4 | 同 | UIH.5 | open/close の v1 receiver スコープ（sequence 限定の維持 or 全 receiver 一般化・§8 Q1）。決定に応じて「未実装」注記の更新 | P4 前 |
| 5 | 同 | UIH.8 | 無人 E2E の具体方式（**検証対象 = ウィンドウ実在まで**・二重経路確認〔自己申告 + CGWindowList〕・3 閉路の駆動法・実プラグイン smoke 別枠・「つまみ→音」は検査対象外である旨）を検証節へ反映 | P6 前 |
| 5b | PLUGIN_CAPABILITY_ABSTRACTION_v1 | CAP.4 / CAP.6-7 | **owner の 2 本足決着との整合**: CAP.4 の LLM 面「param 列挙・設定」と CAP.6-7 の「CAP-PARAM-* の MCP tool 提供」は、**設定系 = DSL 経由（#506）が第一級**・MCP 直接設定は第一級経路でない、へ改訂が要る（列挙・観測系 MCP は維持）。**owner 承認必須の改訂** | #506 設計前 |
| 6 | PROJECT_FILE_SPEC_v1 | PRJ.3 実装状況表 | (b) UI クローズ時 → 実装済みへ更新 + 観測表面（ui-close snapshot ログ 1 行）の規定 | P4 完了時 |
| 6b | PROJECT_FILE_SPEC_v1 | PRJ.0 または PRJ.5 近傍 | **スナップショットの対象境界を規範化**: 「対象は GUI 由来の編集。オートメーション値（DSL 宣言）は保存対象ではない — DSL が担保する」（owner 決着 2026-07-30 の反映。#506/#460 の復元順序規則への参照つき）。**owner 承認要** | P4 前 |
| 7 | PLUGIN_CAPABILITY_ABSTRACTION_v1 | CAP.6-7 | `open_plugin_ui` / `close_plugin_ui` の tool スキーマ確定後の反映（スキーマがコードにしか無い状態を作らない） | P4 完了時 |
| 8 | core/INSTRUCTION_ORBITSCORE_DSL.md | フェーズゲート反映 | REPL メタ行（`//#pluginUi`・P4c 実装済み）と右クリックメニューのユーザー可視面 | P5 完了時 |

---

## 8. owner 確認事項 — **全件裁定済み（2026-07-31）**

> 各項の冒頭に **🟢 裁定** を記す。裁定の一次記録は `docs/development/WORK_LOG.md`（commit `9dea05e` の「その他の裁定」節・および 2026-07-31 の owner 回答）。**本節の「推奨」は起案時点の記述であり、裁定と食い違う場合は裁定が正。**


**Q1. open/close の v1 receiver スコープ** — UIH.5 は「v1 は sequence 限定」と明記するが、
#577 の受け入れ基準は「sequence / master / sum / aux のいずれでも **UI で音色を作る**」を要求
しており矛盾する。
- (a) sequence 限定を維持（#577 受け入れはバス分だけ API 経路で満たす）
- (b) **全 receiver へ一般化**（推奨）: 宛先解決は `save_plugin_state` が既に全 receiver で
  実装済みの語彙（`sum:`/`aux:`/`master`）をそのまま使うため、追加コストは小さい。
  #577 の受け入れ文言とも整合する
- 推奨 (b)。確信度: 中〜高（実装コストの見積りは daemon の bus 側 child host が effect 用に
  既存であることに依拠。反証条件: bus effect の mailbox 配線が sequence 側と非対称だった場合 —
  P0 で確認する）

> 🟢 **裁定（owner・2026-07-31）: (b) 全 receiver へ一般化。** 確定事項・再議論しない。

**Q2. STATE_DIRTY の運搬** — UIH.2a（リング搭載・owner 確定 spec）と #577 PR-B 設計
（`dirty_epoch` 1 語）が現時点で分岐している。
- (a) spec どおりリングに載せる（PR-B を リング上に実装し直す）
- (b) **`dirty_epoch` 語で恒久化し、リングは UI_CLOSED / UI_CLOSED_DONE 専用に spec 改訂**（推奨）
- 推奨理由: dirty は定義上合流可能で、単調カウンタが正準の合流構造。リング占有・
  「dirty の ack でフェーズ B 誤発火」ハザード・pending フラグ規則が丸ごと消える。
  spec 自身が UI_RESIZED を同じ理由で排除している（「消費者の無い高頻度イベントは
  リングを塞ぐ」）。確信度: 高。反証条件: dirty に「host が読むべき付随引数」が将来必要に
  なった場合（カウンタでは運べない）

> 🟢 **裁定: (b) `dirty_epoch` で恒久化。** リングは `UI_CLOSED` / `UI_CLOSED_DONE` 専用。
> **spec 反映済み**（`9dea05e`・UIH.2a）。

**Q3. 新規 Rust 依存** — NSApplication / NSWindow / delegate に `objc2` + `objc2-app-kit` を
追加したい（メンテ活発・型付き・unsafe 最小）。代替: 生 `objc` crate（メンテ停滞）や
自前 msg_send FFI（監査コスト大）。推奨: objc2 系。

> 🟢 **裁定: moot。** `objc2` / `objc2-app-kit` / `objc2-foundation` は **P1 で導入済み**
> （`orbit-child-runtime/Cargo.toml`）。P3b 以降で新規依存は増えない。

**Q4. #474 の v1 スコープ確認** — owner 優先度コメント（2026-07-18）どおり
「**Open/Close UI のみ**」とし、Show info / Reveal in Finder / Rescan catalog / 階層ブラウズ /
右クリック挿入は**別 issue に分割**する。（この分割自体の確認。メニュー項目の器だけ先に
作ることもしない）

> 🟢 **裁定: v1 = Open/Close UI の追加のみ。🔴 分割先 issue は不要（本文の「別 issue に分割する」は失効）。**
>
> | 項目 | 裁定 |
> |---|---|
> | Show info / Reveal in Finder | **不要** |
> | 右クリック挿入 | **不要**。挿入トリガーは **#522 / #506 と同時設計**。`editor.action.triggerSuggest` は<br>コードベース全体で未使用で連鎖が繋がっておらず、現行 `.effect("` 前提で作ると #522 で作り直しになる |
> | 階層ブラウズ | **補完（#495）で満たす** |
> | Rescan catalog | **3面すべて実装済み**（コマンドパレット / `editor/context` / MCP `rescan_plugins`） |
>
> 2026-07-31 に本文を鵜呑みにして issue #595 を作成し、同日クローズした。
>
> **実装時に効く既存資産**: `editor/context` メニューは既に存在する
> （`packages/vscode-extension/package.json:232`・`when: resourceExtname == .orbs`・`group: "orbitscore"`）。
> P5 の「Open Plugin UI」/「Close Plugin UI」は**メニューを新設せず既存グループに足す**。

**Q5. REPL メタ行の対称性** — `//#savePluginState` と対称の `//#openPluginUi` /
`//#closePluginUi` を P4 で足すか。推奨: 足す（コスト小・REPL 面の対称性維持）。ただし
「メニューと MCP で十分」なら省略可。

> 🟢 **裁定: 足す。** `//#openPluginUi` / `//#closePluginUi` を P4 で追加する。
>
> **実装ノート（P4c）**: 当初裁定の 2 本のメタ行は、実装では JSON payload に
> `action: 'open' | 'close'` を持つ**単一の `//#pluginUi`** に統合した
> （`packages/engine/src/cli/repl-mode.ts` / `packages/vscode-extension/src/plugin-ui-bridge.ts`。
> 空白や記号を含む receiver 名・相関 requestId・`expectedName` を 1 つの JSON で運ぶため）。
> 裁定の実質（REPL 面の対称性を P4 で提供する）は変わっていない。

**Q6. ウィンドウタイトル規約**（軽微・実装時決定でも可）— `<plugin name> — <receiver>[<index>]`
を提案（同一プラグイン複数インスタンスの識別のため）。

> 🟢 **裁定: 提案どおり** `<plugin name> — <receiver>[<index>]`。

**Q7. CAP.4 / CAP.6-7 の改訂**（v2 追加）— owner の 2 本足決着（オートメーション = DSL 経由が
第一級・MCP 直接設定は第一級経路でない）は、CAP.4 の LLM 面「param 列挙・設定」と CAP.6-7 の
「必須能力には MCP tool が対応して存在する」と**文言上衝突**する。提案: 設定系は
「DSL 表面（#506）が第一級・MCP は列挙/観測」へ改訂。CAP spec は owner 確定文書なので承認要。

> 🟢 **裁定: 改訂する。** CAP.6-7 を「**列挙・取得は MCP / 設定は DSL（#506）が第一級**」へ。
> MCP の設定系 tool は計測・デバッグの副経路として禁じないが、**CAP.4 のループはこれに依存してはならない**。
> **spec 反映済み**（`9dea05e`）。

**Q8. #577 受け入れの合成判定の承認**（v2 追加・§5b-3）— 「#474 のウィンドウ実在証明 +
#577 の記録復元証明 + クローズセーフポイント統合 E2E 1 本」の合成で「UI で音色を作る」を
満たすとする判定（+ Epic 最終受け入れは owner の実プラグイン 1 回デモ）を owner に確認する。

> 🟢 **裁定: 段階的に承認**（oracle で無人 E2E → 実プラグイン smoke → シナリオ化して自動 E2E へ昇格）。
> 🔴 統合 E2E は **capture WAV のアサーションまで通す**こと（「ok が返った」で済ませない）。

---

## 9. 確信度と反証可能性（設計全体）

| 主張 | 確信度 | 反証条件 |
|---|---|---|
| P1（runloop 化）が UI ホスティングの前提として必須 | 高（NSApplication のプロセス先頭スレッド要件は AppKit の確立された制約・spec UIH.0 も同旨） | Accessory ではなく別方式（CFRunLoop のみで NSWindow を回す等）で足りると実証された場合。ただし plugin GUI は NSApp イベントループ前提のものが多く、部分解は薦めない |
| audio 専用スレッド化でレイテンシ目標を維持できる | 中 | `roundtrip_latency_gated` の退行。退行時は UIH.7 の規定どおり設計見直し（P1 に停止条件として内蔵済み） |
| 既存 mailbox + 新 evt リングで IPC が足りる（新チャネル不要） | 高（CommandMailboxHost 実装・daemon event frame 実測に依拠） | UI 操作に高頻度・大容量の child→host 通知が必要になった場合（現 spec は resize すら载せない方針なので想定外） |
| セーフポイント (b) の daemon↔engine 跨ぎ設計 | 中〜高 | engine 側 save フローが同期呼び出し前提で event frame 起点に載らない構造だった場合（P4 着手時に project-state-store の呼び出し規約を確認して確定させる） |
| #577 受け入れは #474 + #577 + 統合 E2E の合成で満たされる（§5b-3） | 中〜高（owner の「自明」裁定の論理〔プラグイン内部はホストの検査対象外〕を「つまみ→getState 反映」へ一貫適用。手書き登記却下との違い = バイパスと免除の区別） | owner が「つまみ→getState 反映」を自明の範囲外とした場合（→ owner の実プラグイン 1 回デモを受け入れ必須へ格上げして閉じる） |
| CGWindowList による独立証拠が「報告≠適用」の穴を塞ぐ | 高（pid/bounds は Screen Recording 権限なしで取得可能・変異検証で独立性自体を証明する設計） | macOS の将来バージョンで pid/bounds まで権限化された場合（→ AXUIElement 系 or child への外部プローブに差し替え） |
| regex による cursor→(receiver, index) 解決が v1 に足りる | 中 | 複数文にまたがるチェーン構築が DSL 上可能で常用されている場合（その時は engine 側 expectedName 照合が silent 誤爆を防ぎ、loud エラーで顕在化する — 安全側に倒れる設計） |

---

## 10. 委譲プロファイル（参考・実装フェーズの担当想定）

| フェーズ | 実装 | 備考 |
|---|---|---|
| P1 | Codex | ただし**レイテンシ gated・実機 E2E は main が sandbox 外で実測**（工程表どおり） |
| P2 | Codex | loom モデル検証はユニットなので sandbox で回る |
| P3 | Codex（状態機械）+ AppKit 部は小さく直列に | AppKit 実挙動の確認は実機必須 → main |
| P4 | Codex | MCP/E2E 検証は main |
| P5 | Codex | 実機右クリック確認は main |
| P6 | Codex（oracle GUI）+ main（gated E2E 実走） | CGWindowList は実機ランナー限定 |

各フェーズ 1 PR 以上に分割し、フェーズゲート（既存テスト全 green + 当該受け入れ基準）を
越えるまで次に着手しない（プロジェクト規則 2）。
