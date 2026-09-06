---
title: "Glossary"
chapter-id: "glossary"
verified-against: 69dc968
verified-at: "2026-09-01"
status: draft
---

> **Note**: 本ページは 2026-09-01 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

# Glossary

本サイト全体で使われる用語を一か所にまとめた参照ページです。各章での初出説明の anchor source として機能します。アルファベット順・カテゴリ別に並べています。

---

## DSL / 構文用語

### アンダースコアプレフィックスパターン (Underscore Prefix Pattern)

DSL v3.0 で導入された命名規則。`method()` は設定のみ (次の `run()` / `loop()` まで buffered)、`_method()` は即時適用です。例: `seq.play(...)` vs `seq._play(...)`. 詳細は [ADR-002](/decisions/adr-002-dsl-v3-pivot) を参照。

### 片記号方式 (Unidirectional Toggle)

`RUN()`, `LOOP()`, `MUTE()` に使われるセマンティクス。コマンドを実行すると「現在のグループをこのリストで完全置換」します。`STOP` キーワードや `UNMUTE` キーワードを持たず、inclusion-only の設計です。DSL v3.0 で導入。

### chop

`seq.chop(N)` — オーディオファイルを N 等分して N 個のスライスを作ります。その後 `play()` でどのスライスをどの順で再生するかを指定します。N=1 がデフォルト (ファイル全体を 1 スライスとして扱う)。

### DSL (Domain-Specific Language)

「ドメイン特化言語」。OrbitScore では音楽制作・ライブコーディング向けに設計された言語で、ファイル拡張子は `.orbs`、language ID は `orbitscore`。

### global

`var global = init GLOBAL` で作成するシングルトンオブジェクト。テンポ・拍子・オーディオベースパス・グローバルマスタリングエフェクトを管理します。変数名は `global` である必要はなく `g`, `master` 等でも可。

### init

キーワード。`var x = init GLOBAL` または `var seq = init global.seq` という形で使います。TypeScript 側では `InterpreterV2` が `init` トークンを認識して対応するオブジェクトを生成します。

### LOOP

片記号方式のトランスポートコマンド。`LOOP(seq1, seq2)` で seq1 と seq2 をループ再生グループに設定します。以前 LOOP していたシーケンスは自動停止します。

### MUTE / UNMUTE

片記号方式のミュートコマンド。`MUTE(seq2)` で seq2 をミュートすると、seq1 は自動的にミュート解除されます。`UNMUTE` キーワードは v3.0 で廃止。

### play パターン

`seq.play(1, 0, 1, 0)` のように指定するスライスインデックスのシーケンス。`0` は休符、`N` (1以上) は n 番目のスライスを再生します。

### RUN

片記号方式のトランスポートコマンド。`RUN(seq1, seq2)` で seq1 と seq2 を1回再生グループに設定します。LOOP とは独立したグループを持ちます。

### sequence (旧キーワード)

DSL v1.0 (MIDI フェーズ) のキーワード。`sequence name { ... }` という形でシーケンスを定義していました。v2.0 以降は廃止され、`var seq = init global.seq` に置き換わりました。VS Code 拡張の診断機能が `DiagnosticTag.Deprecated` で警告を表示します。

### setDocumentDirectory

`global.setDocumentDirectory("path/to/dir")` — `.orbs` ファイルのディレクトリを engine に伝えます。`audioPath()` および `audio()` で相対パスを解決する際の基準として使われます。VS Code 拡張の `runSelection()` が以下のタイミングで自動注入します:

- `var global = init GLOBAL` を含むブロック評価時 (init の直後に挿入)
- 上記 init 後の任意の評価 (コード先頭に prepend、`.orbs` ファイル切り替えにも追従)

CLI (`playFile`) では `.orbs` ファイルパスから自動導出されます。

`process.cwd()` へのフォールバックは存在しません。documentDirectory が未設定で、かつ相対パスが指定された場合は明示エラーになります（絶対パスは常に許容）。

### SoT (Single Source of Truth)

単一信頼情報源。OrbitScore では「code が SoT」という原則が貫かれています。ドキュメントはコードの理解の snapshot であり、コードと矛盾する場合はコードが正しいとみなします。

### subject-based block evaluation

`runSelection()` の動作モード。カーソル位置の行から subject (変数名) を検出し、そのファイル内で同じ subject を持つすべての行をまとめて engine に送ります。詳細は [IV-2](/editor/execution-feedback) を参照。

---

## Rust Engine / daemon 用語

### orbit-audio-daemon

`rust/crates/orbit-audio-daemon` の binary。WebSocket IPC（protocol v0.2）で TS engine から命令を受け、cpal で音を出します。cutover #108（2026-07-03、WORK_LOG 6.179）以降の**既定バックエンド**で、`.vsix` には `scripts/copy-daemon-bin.sh` で同梱されます。詳細は [RE-1](/rust-engine/)。

### AudioEngineBackend（backend seam）

`packages/engine/src/audio/engine-backend.ts` の interface。interpreter / scheduler が音声バックエンドに要求する唯一の契約面で、`SuperColliderPlayer` と `RustEnginePlayer` の両方がこれを満たします。`boot` / `quit` / `loadPlugin` / `applyEffectChain` / `setGlobalGain` / `pluginNoteOn` 等を持ちます。

### ORBITSCORE_ENGINE

バックエンド選択の環境変数。`sc` または `supercollider` で SuperCollider 経路に opt-out、未設定・それ以外は Rust daemon（`create-audio-engine.ts` の `resolveEngineKind()`）。VS Code 設定 `orbitscore.engine` が対応します。

### RustEnginePlayer / DaemonClient

TS 側の Rust 経路。`packages/engine/src/audio/rust-engine/rust-engine-player.ts` が `Scheduler` として PlayAt を組み立て、`daemon-client.ts` が WebSocket で daemon に送ります。playhead 用の `[STEP]` 行もここから出ます。

### OOP child（out-of-process child）

3rd-party プラグインを daemon とは別プロセスで動かす子プロセス。`orbit-clap-effect-child` / `orbit-vst3-effect-child` / `orbit-clap-instrument-child` / `orbit-vst3-instrument-child` / `orbit-effect-rack-child` があり、クラッシュ隔離と respawn を daemon（`outproc_*.rs`）が担います。詳細は [RE-2](/rust-engine/oop-children)。

### shm transport（orbit-audio-sandbox）

daemon と child の間の共有メモリ transport。file-backed mmap の SPSC ping-pong で audio block を受け渡し、note / UI イベントは evt リングで運びます。

### insert bus（`seq-bus-<n>`）

`seq.effect()` が使う per-sequence の insert bus。daemon は起動時に inactive な bus を既定 8 本プールし（`ORBIT_EFFECT_BUS_POOL`）、宣言＝activation で有効化します。prefix `seq-bus-` は TS（`sequence-effect-manager.ts`）と Rust（`engine_wrap.rs`）で一致させる契約です。詳細は [RE-3](/rust-engine/insert-bus)。

### sum bus / aux bus（`sum-bus-<n>` / `aux-bus-<n>`）

`global.sum()` / `global.aux()` が使うミキサーバス。TS `mixer-manager.ts` の `SUM_BUS_PREFIX` / `AUX_BUS_PREFIX` と Rust `engine_wrap.rs` の既定プール prefix が一致する契約で、v1 は同時 4 本ずつ（`MIXER_BUS_POOL_SIZE`）。詳細は [SC-2](/signal-chain/mixer-audio-line)。

### receiver id（`sum:<name>` / `aux:<name>`）

プラグイン state 永続化（#564）でミキサーバスを指す prefixed 識別子。`formatReceiverId()` / 対応 parser が唯一の wire format の置き場所です。

### capture seam（`ORBIT_CAPTURE_WAV`）

daemon の post-mix 出力を realtime で WAV に書き出す仕組み（`rust/crates/orbit-audio-native/src/capture.rs`）。gated E2E の RMS / peak アサーションの根拠で、#651 以降はヘッダを定期 patch するので異常終了でも開けます。詳細は [RE-4](/rust-engine/capture-verification)。

### LinkAudio（orbit-link-audio）

Ableton Link のオーディオ egress。GPL 依存を `orbit-link-audio` crate に隔離し `cargo-deny` で gate しています。OrbitScore は Link のテンポリーダーになります（#283, #333）。

---

## Plugin Hosting / Signal Chain 用語

### CLAP / VST3

OrbitScore がホストするプラグイン規格。in-process host library（`orbit-clap-host` / `orbit-vst3-host`）と、それを包む OOP child の両方があります。形式判定は拡張子（PH.3）。

### plugin catalog（`~/.orbitscore/plugin-catalog.json`）

`orbit-plugin-scan`（#463）が CLAP / VST3 を走査して書くカタログ。DSL からは bare name で指し（PC.2）、エディタは補完と評価前診断（#638）に使います。詳細は [PH-3](/plugin-hosting/catalog)。

### rack / RackRecipe

`var rack = [ ... ]` のようにチェーンを**値**として書く仕組み（SC.10、#628）。TS の `packages/engine/src/signal-chain/rack.ts` が `catalog` / `standard` / `layer` 要素からなる `RackRecipe` を組み立て、再評価では差分で対応づけます。詳細は [SC-1](/signal-chain/)。

### 標準プラグイン Gain（orbit-std-gain）

言語の語彙として同梱される CLAP プラグイン（SC.10.8）。dB 契約は `tests/e2e/rack-chain-gain-expectations.ts` と CI で固定されます。

### orbit-effect-rack-child

1 つの child プロセスが N 個のステージ（CLAP / macOS VST3）を直列に回すラック child。ラックの要素数だけ child を立てない設計です。

### seq.ui()

楽譜からプラグイン UI を開く DSL（PH.2c、#617 / #628 で名前形）。UI は child プロセスのメインスレッド AppKit runloop（`orbit-child-runtime`）に載り、クローズ状態機械（`orbit-child-ui`、`Closed` はドレーン条件で定義）で管理されます。詳細は [PH-2](/plugin-hosting/plugin-ui)。

### evt リング / dirty_epoch

child → daemon の UI / state イベントを運ぶリング（#474 P2、WORK_LOG 6.337）。`dirty` はリングから外し epoch で運び、ordering を型で封印しています。

### UiEventPump（per-window）

daemon 側で UI イベントを汲む pump。#633 で per-index / per-window 化され、複数ウィンドウの同時 open と宛先解決が実測で確定しました。

---

## MCP / E2E 用語

### MCP サーバ（拡張内蔵）

`packages/vscode-extension/src/mcp-server.ts`。Extension Host 内で Streamable HTTP の MCP サーバを立て、外部エージェント（Claude Code 等）が OrbitScore を操作できるようにします。`ORBITSCORE_MCP_PORT` が設定 `orbitscore.mcpServer.port` より優先し、127.0.0.1 のみに bind します。WCTM の Agent Bridge の系譜。詳細は [IV-3](/editor/mcp-and-gated-e2e)。

### gated E2E（`ORBIT_GATED_ORBITSTUDIO=1`）

`tests/e2e/orbitstudio-mcp-gated.spec.ts`。実 OrbitStudio.app を起動し MCP tool 呼び出しだけで駆動、capture WAV の数値で判定します。`npm run test:e2e:gated` の `pretest` が daemon を自動ビルドします。ゲート env が無ければ skip。

### coverage ratchet

`tests/e2e/dsl-e2e-coverage.spec.ts`。DSL 語彙のうち実機 E2E で未カバーの語の一覧を baseline として持ち、増えたら red（減る方向にしか編集できない）。

### playhead / `[STEP]`

`play()` の引数をエンジンの進行に合わせてハイライトする機能（#390）。engine が出す `[STEP]` 行を拡張（`playhead.ts`）が装飾に変えます。#654 で instrument（MIDI）シーケンスにも配線されました。

### quantize（launch quantize）

`global.quantize("bar")` / `seq.quantize(...)` で `LOOP()` の起動を小節境界まで待つ機能（#212、`quantize-manager.ts`）。`RUN()` は常に即時。

---

## オーディオ / SuperCollider 用語（opt-out 経路）

> 以下は `ORBITSCORE_ENGINE=sc` で opt-out したときにだけ通る SuperCollider 経路の用語です。既定経路の用語は上の「Rust Engine / daemon 用語」を参照してください。

### Buffer (SC)

SuperCollider サーバーが保持するメモリ上の音声データ。WAV ファイルは `/b_allocRead` OSC メッセージでサーバーにロードされ Buffer として保持されます。再生時は Buffer への参照 (bufnum) を使います。

### OSC (Open Sound Control)

音楽・マルチメディア用の通信プロトコル。UDP over IP で動作します。SuperCollider サーバーは OSC サーバーとして動作し、`/s_new`, `/b_allocRead`, `/d_recv` 等のメッセージを受け付けます。

### orbitPlayBuf

OrbitScore が SuperCollider に登録する専用 SynthDef の名前。`PlayBuf` UGen を使ってオーディオバッファを再生します。`startPos`, `duration`, `rate`, `pan`, `amp` パラメータを持ちます。

### scsynth

SuperCollider のオーディオサーバーバイナリ。OSC/UDP で制御を受け付け、SynthDef を実行してオーディオを出力します。v1.0 からは `.vsix` に bundle として同梱されます。

### SynthDef (SC)

SuperCollider のサウンド合成定義。UGen (Unit Generator) のグラフとして表現されます。OrbitScore では `orbitPlayBuf`, `fxCompressor`, `fxLimiter`, `fxNormalizer` の 4 つが使われます。

### UGen (Unit Generator)

SuperCollider の基本処理単位。`PlayBuf`, `Pan2`, `Out`, `EnvGen`, `Compander` 等があり、これらを接続して SynthDef を構成します。UGen は `.scx` プラグインファイルとして提供されます。

---

## VS Code 拡張 / 実行環境用語

### activate() / deactivate()

VS Code 拡張のライフサイクル関数。`activate()` は拡張の初回ロード時に一度だけ呼ばれ、commands・status bar・IntelliSense・diagnostics を登録します。`deactivate()` は拡張のアンロード時に呼ばれ、engine process を kill します。

### activationEvents

`package.json` フィールド。拡張が起動するトリガーを宣言します。OrbitScore では `"onStartupFinished"` (VS Code 起動後に常時起動) と `"onLanguage:orbitscore"` (`.orbs` ファイルを開いた時) の 2 つを使います。

### DiagnosticCollection

VS Code API。ソースコードのエラー・警告を「診断」として登録します。エディタ上に赤/黄色の波線で表示され、Problems パネルにも一覧表示されます。OrbitScore では `updateDiagnostics()` がタイピングのたびに更新します。

### DiagnosticTag.Deprecated

VS Code の診断タグ。このタグが付いた範囲は取り消し線スタイルで表示されます。OrbitScore では `sequence ` キーワード (v1.0 MIDI DSL の残滓) に付けています。

### Extension Host

VS Code が拡張を実行するための専用 Node.js プロセス。Renderer プロセス (UI) から fork されています。DOM へのアクセスはありませんが Node.js API は使えます。OrbitScore 拡張はここで動き、さらに `child_process.spawn` で engine プロセスを起動します。

### flashLines()

`runSelection()` の視覚フィードバック関数。実行した行範囲をエディタ上で点滅させます。`createTextEditorDecorationType` + `setTimeout` ループで実装。`flashCount` / `flashDuration` / `flashColor` が設定可能です。

### language ID (orbitscore)

`.orbs` ファイルに割り当てられた VS Code の言語 ID。IntelliSense・診断・キーバインド等が `orbitscore` 言語に限定して動作します。

### MethodChainContext

`completion-context.ts` のインターフェース。カーソル位置のメソッドチェーンの状態 (`hasAudio`, `hasChop`, `hasPlay`, `hasRun` 等) を表現し、IntelliSense が文脈に応じた補完候補を返すために使います。

### StatusBarItem

VS Code API。エディタ下部のステータスバーに表示するアイテム。OrbitScore は 2 本使います: engine 動作状態 (priority 100) と scsynth 解決状態 (priority 99) です。

### workspace trust (untrustedWorkspaces)

VS Code の信頼モデル。未信頼のワークスペースでは拡張が既定で制限され `activate()` すら呼ばれません。OrbitScore は `package.json` の `capabilities.untrustedWorkspaces` で `supported: true` を宣言し (#385)、フォルダを開かない loose-file 起動でも activate します。`restrictedConfigurations` には「ワークスペースが値を決めると別の実行ファイルが動く」2 件 (`orbitscore.scsynthPath` / `orbitscore.engine`) だけを挙げています。

---

## scsynth Resolver / Bundle 用語

### bundle (scsynth source)

`ScsynthSource` の一つ。`.vsix` に同梱された scsynth バイナリを使う場合の source 識別子。`<engine root>/scsynth/Contents/Resources/scsynth` を指します。

### explicit (scsynth source)

`ScsynthSource` の一つ。ユーザーが `orbitscore.scsynthPath` 設定で明示したパスを使う場合。resolver の最優先です。

### env (scsynth source)

`ScsynthSource` の一つ。`ORBIT_SCSYNTH_PATH` 環境変数で指定したパスを使う場合。`explicit` より低く `bundle` より高い優先度です。開発時に SC.app の scsynth を指定する用途に使います。

### strict mode (scsynth resolver)

scsynth path resolver の動作モード。SC.app や Spotlight への暗黙 fallback を持たず、`explicit > env > bundle` のどれも見つからなければ `ScsynthNotFoundError` を throw します。bundle の同梱失敗をサイレントに隠蔽しないための fail-loud 設計。詳細は [ADR-003](/decisions/adr-003-scsynth-bundle) を参照。

### ScsynthNotFoundError

scsynth が見つからなかった時に throw される Error サブクラス。`searched` フィールドに「検索したけど見つからなかったパスの一覧」を持ちます。エラーメッセージには `ORBIT_SCSYNTH_PATH` による回避方法が案内されます。

### ScsynthResolution

`resolveScsynthPath()` の返り値型。`path` (解決したバイナリパス)、`source` (`'explicit' | 'env' | 'bundle'`) 、`searched` (検索済みパスリスト) の 3 フィールドを持ちます。

---

## 設計・プロセス用語

### ADR (Architectural Decision Record)

アーキテクチャ上の重要な決定を記録する文書形式。「何を、なぜ選んだか」「代替案は何か」「トレードオフは何か」を記録します。Michael Nygard によって広められた形式。本サイトの `decisions/` ディレクトリに格納されています。

### DDD (Documentation-Driven Development)

ドキュメント駆動開発。実装前にドキュメントを書き (または更新し)、そのドキュメントを single source of truth として実装を進めるアプローチ。このプロジェクトでは `docs/core/` 以下のドキュメントが SoT です。

::: info 紛らわしい同名略語
ソフトウェアエンジニアリング全般で "DDD" は **Domain-Driven Design** (Eric Evans) を指すのが一般的です。本サイトでの DDD は **Documentation-Driven Development** を意味し、両者は別概念です。
:::

### ICMC (International Computer Music Conference)

国際コンピュータ音楽学会の年次国際会議。OrbitScore は ICMC への発表を目標に開発されており、`v1.0 release-ready` マイルストーンはその準備を意味します。

### Phase B

本サイト (dev learning site) のコンテンツ執筆フェーズ。Phase A は章のスキャフォールド (stub 状態での目次作成)、Phase B は stub を draft に昇格させる段階です。本書はすべて Phase B で執筆されました。

### stub → draft → reviewed → stable

章のステータスの段階。`stub` は目次と見出しのみ、`draft` は本文が書かれた状態、`reviewed` はレビュー済み、`stable` は長期安定版です。`status` frontmatter フィールドで管理されます。

---

## 次の深掘り候補

- 用語の相互参照の充実 — 各章から用語集へのリンクを追加
- Polymeter / Polyrhythm 用語の詳化 — `scheduling/` 章が完成したら記法の詳細を補記
- Transport / Scheduler 用語の追加 — `transport.ts` / `event-scheduler.ts` に関連する用語
- protocol v0.2 のコマンド語彙 — RE-1 のコマンド表が安定したら 1 コマンド 1 項目に
- Pitch DSL / MIDI 用語（度数・mode lattice・voicing・comp）— MIDI ピラーの用語が未収録

---

## Sources

- `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` — DSL v3.0 仕様書 (Single Source of Truth)
- `docs/archive/DSL_SPECIFICATION_v1.0_MIDI.md` — v1.0 MIDI DSL アーカイブ
- `packages/vscode-extension/src/extension.ts` — activate(), flashLines(), updateDiagnostics()
- `packages/vscode-extension/src/completion-context.ts` — MethodChainContext インターフェース
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts` — ScsynthResolution, ScsynthNotFoundError
- `packages/engine/src/audio/engine-backend.ts`, `create-audio-engine.ts` — AudioEngineBackend seam, ORBITSCORE_ENGINE
- `packages/engine/src/core/global/mixer-manager.ts` — SUM_BUS_PREFIX / AUX_BUS_PREFIX / MIXER_BUS_POOL_SIZE / formatReceiverId
- `packages/engine/src/signal-chain/rack.ts` — RackRecipe
- `packages/vscode-extension/src/mcp-server.ts`, `extension.ts` — MCP サーバ, ORBITSCORE_MCP_PORT の優先
- `tests/e2e/orbitstudio-mcp-gated.spec.ts`, `tests/e2e/dsl-e2e-coverage.spec.ts` — gated E2E, coverage ratchet
- `rust/crates/*/Cargo.toml` — crate description（children / host / scanner / std-gain）
- `docs/archive/WORK_LOG_2026-07.md` 6.179, 6.337 / `docs/archive/WORK_LOG_2026-08.md` 6.413–6.421 — cutover, evt リング, per-window pump, playhead
- `docs/research/SCSYNTH_BUNDLE_MANIFEST.md` — bundle 最小セット調査
- [SuperCollider OSC Command Reference](https://doc.sccode.org/Reference/Server-Command-Reference.html) — `/s_new`, `/b_allocRead` 等の OSC メッセージ仕様
