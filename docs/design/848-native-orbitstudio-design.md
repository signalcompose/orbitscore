# 設計: ネイティブ macOS OrbitStudio — 層 2 のプロセス化・セッションプロトコル・Swift シェル（#848）

**対象 issue**: #848（設計・計画・地図の起案）
**関連**: [`NATIVE_MIGRATION_2026-09.md`](../planning/NATIVE_MIGRATION_2026-09.md)（移行の判断と根拠・**§12 が裁定**）/ [`IMPLEMENTATION_PLAN_NATIVE.md`](../planning/IMPLEMENTATION_PLAN_NATIVE.md)（本設計の実装順）/ [`NATIVE_DEVELOPMENT_MAP.md`](../planning/NATIVE_DEVELOPMENT_MAP.md)（新ラインの地図）
**状態**: 設計（実装しない）・初版 2026-09-11（main `229d6387` 実測・PR #831 マージ後）・**改訂 2026-09-18（main `1276ab1f` 再測・拡張 4.2.0 凍結後）**
**起案 / 審査**: Fable（初版 effort: xhigh / 改訂 effort: high）/ main。**owner 裁定待ちの項目は §14 に集約**し、本文では勝手に確定させていない。
**用語（2026-09-18 owner 確定）**: 本書で **OrbitStudio** は **macOS ネイティブ版アプリ**だけを指す。VS Code 拡張は「拡張版」（4.2.0・機能凍結）。

> 🔴 **読み方**: §0 は再設計しない前提。§1 の**完了条件**が本書の最重要点で、§4 / §5 は「決めた後に戻れない」判断
> （層 2 のプロセス化・プロトコル）なので選択肢を尽くして推奨と理由を書いた。§14 は owner の裁定を待つもの、
> §15 は裁定済み事項への提案（実装しない）。「実測」と書いた箇所はすべて出典（ファイル:行 / 日付 / PR）を併記した。
>
> 🔴 **改訂の読み方（2026-09-18）**: 初版の §2「現在地」は 09-11 の main を根拠にしており、その後 #887 / #888 の分割・#878 の
> spawn 変更・#883 / #939 の表面変更で**数値と前提の一部が古くなった**。§2 を再測値で置き換え、**§2b に「節ごとに生き残ったか
> 崩れたか」の判定表**を置いた。崩れた結論は本文を直し、生き残った結論には根拠を足した。初版の本文は `origin/848-native-design`
> `1bd65b80` に残る。**文書（user / dev サイト）の保持構造**は本書の範囲外だったので、別冊
> [`848-docs-structure-design.md`](848-docs-structure-design.md) に新設した（§9.1・§10.3・D-9 から参照）。

---

## 0. 前提 — 再設計しない裁定（`NATIVE_MIGRATION_2026-09.md` §2・§12）

| # | 裁定 | 本書での扱い |
|---|---|---|
| 2.1 | **macOS のみ**（Apple Silicon・`PROJECT_RULES.md`「Platform Support」） | `cfg` 抽象・Windows 用の温存はしない |
| 2.2 | **Swift / AppKit で新規開発**。Swift の面積はシェルだけ。`NSTextView` でエディタを自作しない | §7 |
| 2.3 | **エディタは Monaco**（§9 の「WKWebView で動くか」に依存） | §7・ステージ N0 の spike |
| 2.4 | **Rust オーディオエンジンは書き換えない**。JUCE を使わない | 層 1 は本書の対象外。daemon protocol は**本書では触らない**。🔴 改訂: 初版が引いた「v0.2」は 09-18 時点で **`PROTOCOL_VERSION = "0.3"`**（`rust/crates/orbit-audio-daemon/src/protocol.rs:8`）— 層 1 の wire は **engine 線（O-wire-b 等）で進む**ので「不変」ではなく「**アプリ線が触らない**」と読む |
| 2.5 | **VS Code 拡張は残すが機能凍結**（Marketplace / Open VSX が発見経路） | §10。🔴 改訂: 凍結は**実行済み** — 拡張 **4.2.0**（`packages/vscode-extension/package.json` `version`・PR #943・2026-09-14）で凍結（owner 2026-09-18）。凍結線は初版の「O-surface 完了」から #883 で **4.0.0** へ動き（`DEVELOPMENT_MAP.md:236-241`）、その後 4.1.0（pan 減衰・#921）/ 4.2.0（#939 / #940）が凍結前の最後の minor になった |
| 2.6 | **VSCodium フォークを畳む** | ✅ gated ハーネスは stock VS Code 起動へ切替済み（PR #831・2026-09-10・`WORK_LOG.md`「test(e2e): launch the gated harness from stock VS Code」） |
| 2.7 | **モノレポ維持**。リリースはパイプラインを分ける（`ext-v*` / `app-v*` は**未決**・§12.7） | §8・§9 |
| 2.8 | **claude-code 拡張は同梱しない**。LLM とは MCP で通信 | §6 |
| §12.2 | 凍結線 = **O-surface（PR-O4）完了** → #883 で **4.0.0** へ移動 → **4.2.0 で凍結済み**（上の 2.5） | 新ラインは凍結の翌日から始めてよい（§12.1）— **その日は来ている**。O-surface の成果物（`//#evalBegin` / `//#evalEnd`・`packages/engine/src/cli/repl-mode.ts:108-115`）は凍結版に入っている |
| §12.3 | **O-multiout が新ラインの最初の束**。ステージ 3〜7 は層 1 / 2 の作業なのでそのまま生きる。ステージ 8（配布）は再定義 | 計画 §2 で束として位置づける。本書は**再定義する配布**だけを設計する（§9） |
| §12 補正 | `runSelection` の subject-block 解決（改訂: #887 で `packages/vscode-extension/src/run-selection.ts:27` `getLineSubject` へ移動）は DSL 意味論に近いので層 2 へ / **同時性**は消えない / walking skeleton の完了条件に **IME** を含める | §5.6・§5.7・§1.3 |
| 地図 §1 | GUI の操作結果は必ず DSL テキストに落ちる（#681）/ LLM は DSL 経由で使う / 投資順位は 1 仕様 → 2 E2E → 3 機能テスト → 4 変異 | §7.2・§1.2 |

**本書が新しく決めるもの**（§2 に無い = 起案の対象）: 層 2 の**プロセス形態と所有権**（§4）/ **セッションプロトコル**（§5）/ MCP の置き場（§6）/ GUI とセッションの責務分割（§7）/ ディレクトリレイアウト（§8）/ 配布の**差分**（§9）/ 拡張を仕様書として使う具体（§10）。

---

## 0b. 既存の検討との関係 — 何を引き継ぎ、何を棄却し、何が失効したか

本書は過去の検討を無かったことにしない。**引き継ぐ**（そのまま前提にする）/ **棄却**（読んだ上で採らない・理由つき）/ **失効**（前提が消えたので判断としては終わっている。ただし中の一次情報は使う）の 3 つに分けて全部並べる。

| 文書 | 結論・内容 | 扱い | 本書での置き場 |
|---|---|---|---|
| `POST_2.0_ROADMAP_NOTES.md`（2026-06-18） | **engine-first** — ネイティブ音声エンジンをどう用意するかが全下流の起点。土台と上物を混同しない | **引き継ぐ**。層 1（Rust daemon）は既に土台として出荷済みなので、本書は「土台の上に上物（アプリ）を組む段」に当たる。順序は engine 線を止めない形（計画 §1） | §0 裁定 2.4・計画 §1 |
| 同 §1 | Tracktion Engine 載せ替え / VSCodium 専用アプリ化（確定方針・当時） | **失効**。Tracktion は `POST_2.0_ENGINE_AND_DISTRIBUTION.md` §0 で Rust へ（2026-06-19）、VSCodium は裁定 2.6 で畳む（2026-09-10） | §11 |
| 同 §1「接続形態は別ネイティブプロセス + IPC が本命」「LLM 連携は差し替え可能な外付け層」 | | **引き継ぐ**。層 1 ↔ 層 2 は今日その形。層 2 ↔ 層 3 も同じ形にする（§4）。LLM は MCP という外付け（裁定 2.8） | §4・§6 |
| 同 §3「session log の再設計は土台後」 | | 引き継ぐ（engine 線の L 束。旧計画 PR-L） | 計画 §4 |
| `POST_2.0_ENGINE_AND_DISTRIBUTION.md`（2026-06-19/21） | engine = 既存 Rust / 楽器 in-process・effects と 3rd-party は out-of-process / audio DSL ⊇ pitch DSL | **引き継ぐ**（層 1 は不変・裁定 2.4） | §3 |
| 同 §2.4「**engine を clean に埋め込み可能に保つ（daemon/engine ↔ editor の分離を崩さない）**」 | b2（engine をプラグイン shell に埋め、editor は別アプリで接続）の feasibility を担保する制約 | **引き継ぐ**。層 2 を独立プロセスにし editor をその**クライアント**にする本書の形は、この制約をそのまま満たす（editor が別アプリでも session に繋げる） | §4 |
| 同 §5 配布チャネル「App Store は不可・**Steam + Developer ID notarize の直接配布**」 | | **引き継ぐ**（Developer ID 署名・公証は 656 §5 と同じ。Steam は本書の範囲外） | §9 |
| 同 §6「`.vsix` は 2.0.0 で feature freeze・パッチ口は残す」 | | **引き継ぐ**（裁定 2.5 と同じ。凍結線は §12.2 で O-surface に更新） | §10 |
| 同 §2.5 / §7「OrbitStudio（VSCodium）を native の上で」 | | **失効**（裁定 2.6） | — |
| `NATIVE_ENGINE_TRACKTION_VSCODIUM.md`（2026-06-18） | Tracktion feasibility（ヘッドレス駆動 3-0 / 外部ホスティング未確証）・VSCodium は fork でなく rebuild スクリプト群 | **失効**（両方とも採らない方向が裁定済み）。**一次情報の作法は引き継ぐ**: 「確証が低リスク側に偏っている時は、動機の核心が未検証であることを併記する」→ 本書 §13 は Monaco × IME を**低**と正直に書く | §13 |
| 同 §6「**editor に着手する前に engine の最大の未知数を最小コストで実証**」 | de-risk スパイクを先に | **引き継ぐ**（形を変えて）: 本書の最大の未知数は engine ではなく **Monaco × WKWebView × IME** なので、N0 spike を先頭に置く | §1.3・計画 N0 |
| `EDITOR_HOST_AND_APP_SIZE.md`（2026-08-30） | 拡張 9,131 行のうち **vscode 非依存 4,726 / 依存 4,405**。依存の中身はダイアログ・パレット・設定・TreeView・ステータスバー・診断表示であって**テキスト編集は 1 つも無い** | **引き継ぐ**。🔴 改訂: 09-18 の再測は **40 ファイル 10,471 行のうち vscode 依存 15 ファイル 4,409 行 / 非依存 26 ファイル 6,062 行**（§2）。**依存の行数は 08-30 の 4,405 → 4,409 でほぼ動いていない** — #887 の分割で依存コードが `extension.ts` から 14 ファイルへ**配られた**だけで、依存の総量は増えていない。「書き直す約 4,400 行 = 編集面の配線」は**そのまま §7.4 パリティ表の母集団** | §2・§2b・§7.4 |
| 同 §7.1「**自作しない**。VSIX + 軽量化 VSCodium 同梱」 | | **失効**（裁定 2.2 が 2026-09-10 に覆した）。ただし同書が挙げた対価「**VS Code が無料で提供しているもの**（設定 UI・キーバインド・複数ファイル・検索・undo/redo・ハイライト）を自前にする」は**そのまま本書の払う費用**であり、§7.1 の `NSDocument` / Monaco 標準機能（検索・undo）はそれへの答え | §7.1・§7.4 |
| 同 §3-5 ソースマップ 334 MB・trim → 署名の順序 | | trim 自体は**失効**（Electron が無い）。「**署名済みバンドルを後から触ると署名が壊れる**」原則は**引き継ぐ**（`make-bundle.sh` の順序） | §9.2 |
| 同 §7.2「`.vsix` が機能の 100%・app 版 = 拡張版」 | | **失効**。ネイティブ app は拡張と別物なので **app 版 = 拡張版 が定義として成立しない** → バージョンの正本を決め直す（§14 (14)） | §9・§14 |
| `656-release-design.md`（2026-09-03） | 署名・公証・cold-install・ローカルリリース・Marketplace | **§0 の裁定 10 件と §16 の回答 8 件を 1 行ずつ引き継ぐ / 失効に仕分けする**（§9.0 の表）。再設計しない | §9 |
| `USER_OUTCOMES_2026-09.md` | 各 PR / ステージが終わるとユーザーは何ができるか（🎵 / 👀 / 🧱 / 📄） | **引き継ぐ**（粒度の手本）。地図 §3.3 に同じ形の表を置く | 地図 §3.3 |
| `post-icmc/ELECTRON_APP_PLAN.md`（Electron + Monaco） | Electron 3 プロセス構成・Monaco 統合・IPC・機能列挙・electron-builder・自動更新・拡張性 3 案 | Electron は**棄却**（裁定 2.2・Tauri 不採用 #94 も同じ系）。**機能列挙は引き継ぐ**: File メニュー（New / Open / Save / Save As）・検索置換（Monaco 標準）・ステータスバー（engine 状態 / **BPM** / カーソル位置）・設定パネル・Monaco の**カスタムビルドで約 1 MB**（不要言語の worker を外す）。拡張性 3 案は **DSL Plugin（#671 / #672）**に置き換わった | §7.4・§11 |
| `post-icmc/AUDIO_ENGINE_CORE_ARCHITECTURE.md`（2026-04-17） | Core は DSL / musical time / UI を**知らない**。「橋渡しは層ではなくプロトコル（JSON-RPC on WebSocket）」。musical timing は **TS に残し、複数フロントが同じ timing を使う必要が出た時に Rust へ** | **引き継ぐ**。層 2 ↔ 層 3 も「プロトコルで橋渡し」（§5）。🔴 **Rust 化の判断基準は本書の形では満たされない** — フロントは 3 つになるが、timing を持つ層 2 は **1 プロセス**で全フロントを受けるため。したがって MIDI / transport の Rust 化は「複数フロント」ではなく **§9 の実測（聞こえるか）**だけを引き金にする | §4.6 |
| `post-icmc/RUST_ENGINE_MIGRATION_PLAN.md`（2026-04-17） | **Engine-as-a-Service**: エンジンをデーモン化し複数フロント（VS Code / standalone / Web / CLI / LLM）。VS Code 拡張は「LSP 的にエンジンと通信する薄い TS」 | **引き継ぐ**（本書の「クライアント 3 つ・背骨 1 つ」はこの図そのもの。背骨が層 1 + 層 2 の 2 段になった点だけが違う）。Tauri / CodeMirror / Phase 3「Tauri standalone」は**失効**（裁定 2.2・2.3）。「拡張を薄いクライアントに」は §14 (7) として**保留** | §4・§14 (7) |
| `DAW_AUDIO_ARCHITECTURE.md`（2026-06-21） | 標準 DAW の信号経路・**graph は engine core が所有しプラグインは順序を知らない**・PDC・tap 点 | **引き継ぐ**。層 3 の責務境界の参照: DAW の UI は graph を描き替えを**依頼**するだけで所有しない → 本書の「GUI は DSL テキストの編集面」（§7.2）はその写し。PDC / sidechain は層 1（engine 線 K / O-multiout） | §3・§7.2 |
| `2026-09-03-issue-triage.md` | クラスタ C5 配布（#656 / #197 / #184 / #385 / #659 / #321）・#94 Tauri 不採用（CLOSED）・#379 → #656 | **引き継ぐ**（ネイティブ線へ持ち越す配布 issue の母集団 = C5）。#385 は凍結版の話。#321（LinkAudio の GPL）は engine 線 P 束の話で本書は触らない | 地図 §4.D |
| Serena `post_2.0_native_engine_roadmap` | 戦略レイヤ（engine-first・permissive・freemium・**OrbitScore = 言語 / OrbitStudio = 候補名**） | 引き継ぐ（名前は候補のまま・§14 (10)） | §14 |
| Serena `orbitstudio_phase0_phase1_2026-07-07` / `orbitstudio_phase2_spike_2026-07-07` | **OrbitStudio（VSCodium）の Phase 0 / 1 / 2 は一度やりかけて成立していた**: side-load（gate A/B PASS）・B1 リブランド build（`CFBundleIdentifier=com.signalcompose.orbitstudio`・CLI 名 `orbs`）・Claude Code の IDE チャネル probe・#384 / #385 の発見 | **失効**（フォークは畳む）。ただし 3 点は**引き継ぐ**: (a) bundle id の候補 `com.signalcompose.orbitstudio` は**既に一度使われた id**なので、ネイティブ app で同じ id を使うか別にするかは §14 (10) の材料 (b) **#385 型の沈黙**（activate しない・何も起きない）は D-5「黙らない」の根拠 (c) **subagent の detached build は完了通知が飛ばない**運用知見は計画 §5 の委譲に効く | §9・§14 (10) |
| `post-icmc/COLLABORATION_FEATURE_PLAN.md`（P2P 協調・2,750 行） | WebRTC P2P + シグナリング・ホストマイグレーション・各自の engine で鳴らす・音の排他 3 モード | **範囲外**。ただし**後から入れられる形か**だけ確認した: 協調は「document の同期 + 評価要求の中継」であり、本書では層 3 のクライアント（または session 間のブリッジ）として乗る。層 2 が document の写し（§5.5）と FIFO の評価キュー（§5.6）と出自（`clientId`）を既に持つので、**層 2 の中を変えずに**足せる。🔴 同計画の「ホストマイグレーションの確認ダイアログ」は D-5（確認を挟まない）と衝突するので、着手時に設計し直す | §5.5・§5.6 |

---

## 1. 到達点と 🔴 完了条件

### 1.1 到達点（1 文）

**新しい Mac で `OrbitStudio.app` を開き、`.orbs` を書いて ⌘Enter で音が出て playhead が動き、同じセッションに LLM が MCP で入って同じ譜面を評価でき、その全部が凍結版の拡張と同じ gated E2E（同じツール名・同じ golden）で緑になる。**

### 1.2 完了条件（何が緑なら done か・何を検証すれば正しいと言えるか）

「ネイティブ版が拡張版に追いついた」を**自己申告で言わない**ための定義。各行は**仕組み**（テスト・スクリプト）に落とし、CLAUDE.md「規律を足す時は仕組みを足す」に従う。

| # | 条件 | 検証手段（仕組み） | 何が保証されるか |
|---|---|---|---|
| **D-1 パリティ** | 凍結版 gated suite の `it` 題名のうち **native 必須**に分類された全件が、`ORBIT_GATED_TARGET=native`（`OrbitStudio.app` を起動して MCP で駆動）で緑 | `tests/e2e/native-parity-ledger.ts`（新設）: 凍結タグ時点の gated `it` 題名を全列挙し、各題名を `native-required` / `not-applicable(理由)` のどちらかに分類する台帳。**未分類が 1 件でもあれば red**（`dsl-e2e-coverage.spec.ts` と同じラチェット形）。改訂: 母集団は **4.2.0 時点の 49 `it`**（`tests/e2e/orbitstudio-mcp-gated.spec.ts` 7,393 行・`grep -cE "^ +(it\|test)(\.[a-zA-Z]+)?\("`・2026-09-14 実機 **48 passed / skip 0**・`WORK_LOG.md:452`） | 「拡張でできたことがアプリでできる」を**題名単位で機械が数える**。`not-applicable` は owner 裁定（§14 (11)） |
| **D-2 音の同一性** | 既存 golden（`tests/e2e/output-line-expectations.ts` の `OUTPUT_LINE_GOLDENS`・`rack-chain-gain-expectations.ts`）が native / headless ターゲットで **1 つも動かない** | 同じ fixture・同じ capture 窓を同じ helper（`tests/e2e/helpers/capture-windows.ts`）で測る。層 1 は不変（裁定 2.4）なので、動いたら**層 2 の配線か capture の窓が壊れた**ことになる | 束 O-wire と同じ検算（`BUNDLE_BRANCH_WORKFLOW.md` §5.1）。**振る舞いを変えない移行を「動かないこと」で検証する機会**を、アプリの機能追加と混ぜずに使い切る |
| **D-3 LLM 単独** | エディタを 1 つも開かずに `orbitscore session --port N --mcp` を起動し、`ORBIT_GATED_TARGET=headless` で **editor 非依存**の題名が全件緑 | 台帳の `needs-editor` 列で自動 skip。headless で `open_file` 等を呼ぶと構造化エラー `NO_EDITOR_ATTACHED` が返ること自体を 1 本のテストで固定 | 「LLM は第一級ユーザー」（memory `orbitstudio-shared-medium-human-llm`）を GUI 無しで満たす。§3 の「エディタを閉じてもエージェントが動く」の**第 1 リリースでの形** |
| **D-4 特権経路ゼロ** | アプリの GUI が呼ぶ RPC メソッド集合 ⊆ MCP ツールが呼ぶ RPC メソッド集合 | `protocol/` のスキーマで各メソッドに `surfaces: ["gui","mcp"]` を宣言し、`tests/protocol/surface-coverage.spec.ts`（新設）が **`gui` を持つメソッドで `mcp` を持たないものが 1 つでもあれば red** | 「UI に特権的な経路を作らない」（`NATIVE_MIGRATION` §3）を宣言でなく検査で保つ。GUI で出来て LLM で出来ないことが**構造的に作れない** |
| **D-5 確認・停止を挟まない** | 評価経路（`session.evaluate` に至る全 GUI 操作）に**モーダル・確認ダイアログ・自動ウィンドウ開閉が無い** | Swift 側に「評価経路で `NSAlert` を出す API を持たない」（§7.3 の構造）+ gated `native` で `run_selection` を 50 回連続して所要時間の分散が閾値内（モーダルが出ると人待ちで秒単位に跳ねる。閾値は N2 で実測して決める） | memory `live-coding-forbids-workflow-interruptions` / `ui-windows-only-open-and-close-by-user` |
| **D-6 IME** | Monaco 上で日本語入力（変換・確定・未確定文字列の描画・⌘Enter が変換中に評価を起こさない）が実機で動く | 🔴 **自動化できない**（IME はアクセシビリティ API から駆動しにくい）。**owner の実機確認**を N0 / N2 の受け入れに置き、確認した日付とビルド hash を `WORK_LOG` に残す | 裁定 §12.7 (6)「Phase 2 spike（Monaco + IME）」 |
| **D-7 cold-install** | 何も入っていない macOS アカウントで `.dmg` → 起動 → 初めて開くフォルダの `.orbs` を評価して音が出る。**PATH の `node` が無くても**起動する | `656-release-design.md` §6 の E2E-D3 の形（PATH を絞って走らせる）を native 成果物へ向ける。署名は `spctl --assess`。改訂: 凍結版には同型のテストが**既に在る**（`npm run test:e2e:cold-install`・`tests/e2e/vsix-cold-install-gated.spec.ts`・#873 / #878）。その `.app` 版を書く | 配布の再定義（§9）。W-22（node 同梱）の帰結。改訂: 拡張版は #878 で **VS Code 同梱の Node**（`process.execPath` + `ELECTRON_RUN_AS_NODE`・`engine-process.ts:407-416`）を使うようになり PATH 非依存になったが、**ネイティブ app には Electron が無い**ので node 同梱の必要はアプリ線だけに残る |
| **D-8 文書** | 地図 §「現在地」が事実と一致（閉じた issue を未着手と書かない） | `tests/docs/planning-issue-state.spec.ts` の `DOCUMENTS` に `NATIVE_DEVELOPMENT_MAP.md` / `IMPLEMENTATION_PLAN_NATIVE.md` を足す（🔴 本 PR は `tests/` を触らないので **main の follow-up**。改訂: 09-18 時点でも `DOCUMENTS` は旧地図と旧計画の 2 本だけ・`planning-issue-state.spec.ts:41-44`・**未対応のまま**） | #814 と同じ仕組み |
| **D-9 文書同梱**（改訂で追加・owner 要件 2026-09-18） | `.app` 単体（ネットワーク無し・リポジトリ無し）で **Docs パネルと `docs.get` / `docs.search` が同梱文書を返す**。同梱文書に「未リリース」マーカーが **0 件** | `verify-app.sh` が `Contents/Resources/docs/manifest.json` と `index.html` の実在を検査 + cold-install E2E（D-7）で `get_dev_doc` 相当を 1 回叩く + `未リリース` マーカーの grep が 0 件（別冊 §6.4） | 🔴 凍結版では docs は **`.vsix` に同梱されておらず**（`.vscodeignore:20,28` が `../../**` を除外）、`mcp-server.ts:137-138` は `__dirname/../../..` = **モノレポのルート**を前提に `sites/*/.vitepress/dist` を探すので、**cold install では Docs パネルも `get_dev_doc` も動かない**。これは gated E2E にも 1 本も無い（`grep -n "get_dev_doc\|search_dev_docs" orbitstudio-mcp-gated.spec.ts` = 0 件）。「アプリに同梱して LLM に読ませる」は新しい表面なので完了条件に入れる。詳細は [`848-docs-structure-design.md`](848-docs-structure-design.md) |

**done の判定は D-1〜D-9 の全部**。D-6 だけが人手で、それ以外は機械。**「ユニット緑」はどの条件にも現れない**（CLAUDE.md「ユニットは部品しか見ない」）。

### 1.3 walking skeleton（ステージ N2）の完了条件

裁定 §5 Phase 2 の文をそのまま受け、IME を足す:

1. ウィンドウが開き、WKWebView に Monaco が載って `.orbs` がハイライトされる
2. 層 2（`packages/session`）に繋がり、選択範囲評価で**音が出る**（capture WAV の RMS > 0・`ORBIT_GATED_TARGET=native` の 1 本目）
3. playhead が動く（`transport.step` イベントが WebView に届き decoration が出る。既存 `playhead.ts` の pure 関数を再利用）
4. **日本語 IME が動く**（D-6）
5. タブ・保存・設定は**無い**（あると skeleton の判定が遅れる）

🔴 **ここが崩れたら Electron 検討へ戻る**（裁定 §9「最大の未知数」）。崩れたかどうかの判定は 1〜4 の実機結果で、推測で先送りしない。

---

## 2. 現在地（一次情報・本書が変えるもの）— 🔴 2026-09-18 に main `1276ab1f` で再測

初版（09-11・`229d6387`）の値は各行の「初版」列に残す。**再測でずれた行は 🔴**。ずれが結論に及ぶかは §2b。

| 事実（09-18） | 初版（09-11） | 根拠（09-18・main `1276ab1f`） | 本書 |
|---|---|---|---|
| 🔴 拡張は **40 ファイル 10,471 行**。`extension.ts` **412** 行・`mcp-server.ts` **346** 行（#887 で分割・PR #909・2026-09-13）。500 行超は `engine-process.ts` 683 / `engine-handlers.ts` 530 / `agent-handlers.ts` 518 の 3 本 | 21 モジュール・4,258 / 1,417 | `wc -l packages/vscode-extension/src/*.ts` | §2b・§3 |
| 🔴 **`vscode` を import するのは 15 ファイル 4,409 行、非依存は 26 ファイル 6,062 行**（`extension-state.ts` は `import type` のみ・`extension-state.ts:13`）。依存 15 本: `agent-handlers` / `completion-context` / `diagnostics-provider` / `docs-panels` / `dsl-providers` / `engine-view-provider` / `engine-process` / `extension` / `extension-state` / `flash-config` / `playhead-decorations` / `mcp-register-command` / `plugin-commands` / `run-selection` / `plugin-ui-at-cursor` | 21 本中 2 本が依存・19 本 pure → 「19 本はそのまま層 2 へ」 | `grep -l "from 'vscode'" packages/vscode-extension/src/*.ts`（`require('vscode')` / `from "vscode"` は 0 件） | 🔴 **§3 の「そのまま移せる」は崩れた**（§2b・§3 の 3 分類表） |
| 🔴 拡張 → engine は **stdin の `//#` メタ行 8 種**（初版の 6 種 + `evalBegin` / `evalEnd`・#611 §5.7 = O-surface の成果物）。engine → 拡張は stdout の `✓` / `[STEP] …` / 1 行 JSON 5 種と stderr の `[ERROR] …`（変わらず） | 6 種 | `grep -rho "//#[a-zA-Z]*" packages/vscode-extension/src packages/engine/src \| sort -u` / `repl-mode.ts:108-115` | §5.3 に 1 行足す。結論は生き残る（§2b） |
| 🔴 requestId 相関ブリッジは拡張側に **5 本 654 行**（`device-switch` 116 / `engine-state` 138 / `eval-mark` 142 / `plugin-state` 117 / `plugin-ui` 141・#757 OPEN のまま・旧地図 `DEVELOPMENT_MAP.md:1164`）。**ブリーフの「6 本」は誤り** — `playhead-decorations.ts` はブリッジではない | 5 本 625 行 | `wc -l packages/vscode-extension/src/*-bridge.ts` | §5: request id を wire に持たせて**ブリッジそのものを消す**（変わらず） |
| 送信は `writeCodeToEngine()` 1 箇所に集約（#887 で `engine-process.ts:645-673` へ移動）。`//#documentDirectory` を先頭に注入し `global.setDocumentDirectory(...)` も DSL として注入する（変わらず） | `extension.ts:3117-3149` | `engine-process.ts:645,658,673` | §5.5: `evaluate` の引数 `documentDirectory` に畳む |
| 🔴 engine は **VS Code 同梱の Node** で spawn される: `child_process.spawn(process.execPath, …, { env: { ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' } })`（#878・PR #889・2026-09-12） | PATH の `node` | `engine-process.ts:382-416` | §9: **拡張側の W-22 は不要になった**。ネイティブ app には Electron が無いので同梱 node は**アプリ線だけ**の判断として残る（§9.1・§14 (3)） |
| daemon は engine（TS）が spawn し ready 行から port を得て WebSocket 接続。bind は `127.0.0.1:0`（変わらず） | 同じ | `daemon-client.ts:6,152` / `server.rs:19` | §4.4 |
| daemon バイナリは explicit → env `ORBIT_AUDIO_DAEMON_PATH` → monorepo release → monorepo debug → 拡張同梱 の順（変わらず） | 同じ | `daemon-client.ts:125,211-212,250-260` | §9 |
| 🔴 daemon protocol は **v0.3** | v0.2 | `protocol.rs:8` | §0 2.4: 層 1 の wire は engine 線で進む。アプリ線は触らない |
| MCP は拡張プロセス内の HTTP（Streamable HTTP・`/mcp`・`mcp-session-id`）。ツールは **26 個**（変わらず・ただし**中身が違う**: `force_kill_scsynth` は #502 で消え、`open_plugin_ui_at_cursor` が #939 で増えた）。🔴 登録は `mcp-server.ts` ではなく **`mcp-tools-editor.ts` 12 / `mcp-tools-engine.ts` 7 / `mcp-tools-plugins.ts` 7** に分かれ、実装は **`OrbitScoreToolHandlers`**（`mcp-types.ts:176-224`）という**インタフェース 1 本**で受ける | 26 個・`mcp-server.ts` に 26 件 | `grep -c "registerTool(" packages/vscode-extension/src/mcp-tools-*.ts` / `grep -A2 registerTool … \| grep -o "'[a-z_]*'" \| sort -u` = 26 | §6: **移す単位が「ファイル 1 本」から「MCP 層 8 ファイル 1,658 行 + インタフェース実装」に変わり、継ぎ目は既に型で在る**（結論は強まる） |
| 🔴 MCP 層で vscode 非依存なのは **8 ファイル 1,658 行**（`mcp-server` 346 / `mcp-tools-editor` 288 / `mcp-tools-plugins` 256 / `mcp-types` 230 / `mcp-docs` 190 / `mcp-tools-engine` 158 / `mcp-sdk` 128 / `mcp-registration` 62）。**ブリーフの「9 ファイル 1,875 行は完全に vscode 非依存」は誤り** — 9 本目の `mcp-register-command.ts`（217 行）は `vscode.window.showQuickPick` 等を使う（依存） | （記述なし） | `grep -l "from 'vscode'" packages/vscode-extension/src/mcp-*.ts` = `mcp-register-command.ts` のみ | §6 |
| gated E2E の MCP クライアントは SDK 非依存の生 HTTP（変わらず）。ハーネスは stock VS Code を `--extensionDevelopmentPath` + `ORBITSCORE_MCP_PORT` で起動 | 同じ | `helpers/mcp-client.ts:1-10` / `orbitstudio-mcp-gated.spec.ts:757,763` | §10 |
| 🔴 gated は **49 `it` / 実機 48 passed・skip 0**（2026-09-14）。suite は **7,393 行**（09-11 の 5,994 行から +1,399・#917 の E2E-4/5 ほか） | 29 passed / 1 failed | `grep -cE "^ +(it\|test)(\.[a-zA-Z]+)?\(" tests/e2e/orbitstudio-mcp-gated.spec.ts` / `WORK_LOG.md:452` | D-1 の母集団が **1.6 倍**になった。台帳は凍結タグ（4.2.0）の題名で作る |
| engine（TS）は **23,723 行**（`core/` 9,624 / `audio/` 4,510 / `parser/` 3,398 / `midi/` 1,759 / `interpreter/` 1,646 / `cli/` 1,402 / `signal-chain/` 829 / `timing/` 496）。`audio/supercollider/` は #502 で消え、`child_process` の利用は `daemon-client.ts` に閉じる | 24,330 行・`child_process` 2 本 | `find packages/engine/src -name '*.ts' \| xargs cat \| wc -l` / `ls packages/engine/src/audio/` | §4.2: in-process 化（JSC）を退ける根拠は変わらない |
| MIDI は `setInterval` 5 ms + `Date.now()`、transport は `setTimeout`（再測せず・裁定 §7 のまま） | 同じ | `midi-scheduler.ts` | §4.6 |
| 🔴 拡張の表面: コマンド **16**・キーバインド 1・設定 **8**（`scsynthPath` / `engine` が #502 で消えた）・ビュー 2・言語 1・walkthrough 1。**`openPluginUiAtCursor`（#939・右クリック → その 1 つの UI）が増え、`forceKillScsynth` が消えた** | 17 / 10 | `node -e "…package.json contributes…"` | §7.4 に 1 行足す |
| VS Code API の使用（上位）: `registerCommand` 19・`showInformationMessage` 16・`getConfiguration` 12・`showErrorMessage` 12・`workspaceFolders` 11・`showWarningMessage` 11・`activeTextEditor` 11・`showQuickPick` 5・`showInputBox` 4・decoration 3・completion provider 3・TreeDataProvider 2・StatusBarItem 2 | ほぼ同じ | `grep -ho "vscode\.[a-zA-Z]*\.[a-zA-Z]*" … \| sort \| uniq -c` | §7.4 |
| `apps/` `protocol/` `packages/session/` は**存在しない**（変わらず） | 同じ | `ls -d apps protocol packages/session`（2026-09-18） | §8 |
| 同梱バイナリは 7 個 + `Gain.clap`（変わらず） | 同じ | `scripts/copy-daemon-bin.sh:120-128` | §9 |
| Rust は **22 crate・83,497 行**。`orbit-audio-daemon` 27,506 行、うち `engine_wrap.rs` 単体 6,848 行（#888 の Rust 分割は B-1 / B-2 / C-3 が入った・PR #895 / #896 / #897） | （記述なし） | `ls rust/crates \| wc -l` / `wc -l` | 層 1 は本書の対象外。数字は地図 §3.1 の現在地用 |
| 🔴 **docs は `.vsix` に同梱されていない**。拡張の Docs パネル / `get_dev_doc` は `__dirname/../../..`（= モノレポ root）の `sites/*/.vitepress/dist` を読む | （記述なし） | `.vscodeignore:20,28` / `mcp-docs.ts:29-36` / `mcp-server.ts:137-138` / `docs-panels.ts:17-26` | D-9・別冊 |
| 署名 identity・ASC API キー・順序・entitlements 未確認（変わらず） | 同じ | `656-release-design.md` §5.1-5.3 | §9 |
| per-PR の macOS ランナーは回さない（変わらず） | 同じ | `rust-ci.yml:1-24` | §9.4 |
| `planning-issue-state.spec.ts` が走査する文書は地図と計画の 2 本だけ（変わらず・**D-8 の follow-up は未実施**） | 同じ | `tests/docs/planning-issue-state.spec.ts:41-44` | D-8 |

### 2b. 🔴 改訂判定 — 節ごとに「生き残ったか / 崩れたか」（2026-09-18）

判定の軸は 1 つ: **§2 の再測値で、その節の結論を導いた前提が変わったか**。「変更なし」とだけ書かず、生き残る理由を根拠つきで書く。

| 節 | 判定 | 根拠（何が前提で、再測でどうなったか） | 改訂で入れたもの |
|---|---|---|---|
| §0 前提 | **生き残る（数値 2 件を訂正）** | 裁定 §12 は変わらない。訂正: protocol v0.2 → **v0.3**（`protocol.rs:8`）/ 凍結線は O-surface → 4.0.0 → **4.2.0 で凍結済み** | 2.4・2.5・§12.2 の行 |
| §0b 既存検討 | **生き残る** | 仕分けの根拠（裁定・一次情報）は変わらない。`EDITOR_HOST_AND_APP_SIZE` の行だけ数値を更新（依存 4,405 → 4,409・**行数の比率はほぼ不変**） | 1 行 |
| §1.1 到達点 | **生き残る** | 「同じツール名・同じ golden」— ツール集合は 26 のまま（中身は #502 / #939 で入れ替わったが、台帳は凍結タグの題名を数えるので吸収される） | — |
| §1.2 完了条件 | **生き残る + D-9 追加** | D-1〜D-8 の検証手段はすべて `tests/` の既存仕組みに乗り、それらは 09-18 も在る。**D-7 の理由が変わった**（拡張は Electron の node を使うようになった #878）が、ネイティブ app に Electron は無いので条件自体は残る。owner 要件「文書をアプリに同梱」は新しい表面 → D-9 | D-1 母集団・D-7 理由・D-9 |
| §1.3 skeleton | **生き残る** | 依存は Monaco × WKWebView × IME（未検証のまま） | — |
| §3 層の責務分割 | **🔴 部分的に崩れた** | 責務の 3 層分けと判定規則は生き残る（何も前提にしていないため）。**崩れたのは「19 本の pure モジュールはそのまま層 2 へ移せる」**。09-18 の 26 本の pure のうち、**層 2 の資産は 17 本 4,290 行**（MCP 層 8 本 1,658 + サービス 8 本 2,296 + `engine-view` 336）で、**残り 9 本 1,772 行は「pure だが host 側の配線か描画側」**（5 本のブリッジ 654 行・`engine-handlers` / `engine-lifecycle` / `engine-startup-runtime` 845 行の child-engine stdout 経路 = 消える 1,499 / `playhead` 273 行 = WebView へ）。検算: 4,290 + 1,499 + 273 = 6,062 = pure の総行数 ✓。これらは**移すのではなく wire で消える / WebView へ行く**。逆に依存 15 本のうち **`agent-handlers` / `run-selection` / `plugin-ui-at-cursor` / `completion-context` は層 2 に落ちる意味論を含む**（`*ForAgent` / subject-block / カーソル下のプラグイン名解決 / 補完の計算） | §3 に **3 分類表**（移す / 消える / 書き直す）を新設 |
| §4 層 2 のプロセス化 | **生き残る** | 選択肢 A〜E の比較は「Node API 依存 22 ファイル / N-API addon / 孤児クラスの実測」に依る。09-18 でも engine の `child_process` は `daemon-client.ts` に閉じ（SC 削除で減った）、`@julusian/midi` は残る。**#878 が示したのは「拡張は Electron の node で足りた」**であって、アプリ線で in-process（JSC）が可能になったわけではない | §4.2 A の行に #878 の注記 |
| §4.4 ライフサイクル | **生き残る** | 「1 host = 1 session = 1 daemon」は daemon-client の spawn 流儀（変わらず）に乗る | — |
| §4.5 ヘッドレス host | **生き残る（根拠が強まる）** | `packages/engine/dist/cli-audio.js repl` を凍結版が同梱・実行する事実は `engine-process.ts:154` で変わらず | 行番号の更新 |
| §5 プロトコル | **生き残る（写像表に 2 行追加）** | P-A〜P-D の比較は wire の構造（1 チャンネル・chunk 境界・逆方向）に依る。再測で構造は変わっていない。**写像表の母集団が変わった**: メタ行 6 → 8（`evalBegin` / `evalEnd`）・ツール 26 の中身（`force_kill_scsynth` 消滅・`open_plugin_ui_at_cursor` 追加）・コマンド `openPluginUiAtCursor` | §5.3 に 2 行・§5.7 の列挙を更新 |
| §5.4-5.6 逆方向・同期・同時性 | **生き残る** | 依存は Node の単一イベントループ（変わらず）と `repl-mode.ts` の FIFO（変わらず） | — |
| §6 MCP の置き場 | **生き残る（結論が強まる）** | 初版は「`mcp-server.ts` 1,417 行をファイル移動し handlers を付け替える」。#887 で **MCP 層は 8 ファイルに割れ、handlers は `OrbitScoreToolHandlers` インタフェース 1 本で受ける形になった**（`mcp-types.ts:176-224`）。層 2 の仕事は「このインタフェースを RPC メソッドで実装する」に**縮まった**。D-4「MCP ツール = RPC の薄い写し」はこのインタフェースがそのまま体現する | §6 を書き直し |
| §7 GUI | **生き残る（表に 1 行追加）** | Swift の面積・`NSDocument`・WebView が RPC クライアント、は VS Code API の使用分布（再測でもダイアログ・設定・TreeView・decoration が主）に依る。**#939 で右クリック → 1 つの UI を開く経路が増えた**ので §7.4 に行を足す。🔴 memory `native-app-unlocks-gui-test-automation`（2026-09-14）: 右クリック等の GUI 操作はネイティブ版で**初めて自動テストできる**（拡張版では computer-use が IDE を click tier に固定） | §7.4 に 1 行 + 設定 8 |
| §8 レイアウト | **生き残る** | `apps/` `protocol/` `packages/session/` は 09-18 も無い。`packages/engine` を rename しない理由（凍結版が `engine/dist/cli-audio.js` を実行）は `engine-process.ts:154` で健在 | — |
| §9 配布 | **🔴 部分的に崩れた（2 点）** | (a) **「engine は PATH の node で spawn」が失効**（#878）。W-22 の「拡張側を同梱パスへ」は不要になり、拡張は VS Code の node に乗った。ネイティブ app では **Electron が無い**ので node 同梱の判断だけが残る（§14 (3) は生きる・理由を更新）。(b) **同梱物に docs が無い**ことが判明（`.vscodeignore`）— §9.1 の `docs/` は「何をどう作って入れるか」が未設計だった → 別冊 | §9.0 の 1 行・§9.1・§9.2 段 2 |
| §10 拡張を仕様書に | **生き残る（数値更新 + 1 行差し替え）** | gated suite は 7,393 行 / 49 `it` に増えたが「同じ suite をターゲットで起動先だけ変える」構造は `orbitstudio-mcp-gated.spec.ts:757,763` で変わらない。**§10.3 の「user サイトはアプリを主語に書き直す」は別冊 Q1 / Q2 の答えで置き換える**（主語の全面書き換えは DSL 記述を二重化するので採らない） | §10.1・§10.3 |
| §11 棄却案 | **生き残る** | 棄却理由はどれも再測値に依らない | — |
| §12 失敗モード | **生き残る + F-11** | 文書同梱の失敗モード（同梱物が古い / 未リリースを書いた）を足す | F-11 |
| §13 確信度 | **書き直し** | 「19 本の pure モジュール」の行が前提ごと消えた。#878 の実測で「Electron の node で N-API addon が読める」が**高**に上がった（ネイティブ app では使えない知見だが、`@julusian/midi` の prebuild が素の node と同じく読めた事実は同梱 node の互換の傍証） | §13 |
| §14 裁定待ち | **生き残る + 6 件追加** | (1)〜(14) は 09-18 も未裁定（`IMPLEMENTATION_PLAN_NATIVE.md` §6 の状態列）。文書構造の設計で新たに (15)〜(20) | §14 |

---

## 3. 層の責務分割 — どこに何を置き、どこに置かないか

裁定 §3 の 3 層を、**「何が落ちたら何が止まるか」**と**「誰が真実を持つか」**の 2 軸で確定する。

| 層 | プロセス | 持つもの（真実） | 🔴 持たないもの |
|---|---|---|---|
| **1 発音** | `orbit-audio-daemon`（Rust）+ plugin child 群 | オーディオ I/O・サンプル精度スケジューラ・ミキサー・プラグインホスト・capture。protocol v0.2 | DSL・セッション状態・エディタの何か。**本書で 1 行も変えない**（裁定 2.4） |
| **2 セッション** | `orbitscore session`（Node・`packages/session`・§8） | DSL の評価（`InterpreterV2`）・セッション状態・transport・**MCP サーバ**・**セッションプロトコルのサーバ**・log ring・診断と補完の**計算**（言語サービス）・プラグインカタログの読み書き・`.orbslog` writer・daemon の起動と監視（既存 `rust-engine-player.ts`）・**subject-block 解決**（§12 補正） | 描画・ウィンドウ・ファイルの open/save（NSDocument）・キーバインド・IME。**`vscode` も `AppKit` も import しない** |
| **3-a 編集（拡張）** | VS Code extension host（凍結） | 現状のまま（stdio + `//#` メタ行で `packages/engine` の REPL を叩く） | 新機能（裁定 2.5） |
| **3-b 編集（アプリ）** | `OrbitStudio.app`（Swift シェル + WKWebView の TS） | ウィンドウ・メニュー・`NSDocument`・環境設定・キーバインド・Monaco・パネルの**描画**・layer 2 の spawn と監視 | DSL の解釈・診断の計算・プラグインカタログの解決・MCP。**GUI からの操作はすべて層 2 の RPC メソッド**（D-4） |

**置き場の判定規則**（迷った時の 1 行）: **「エディタを閉じても意味を持つか」→ 層 2。「見た目・入力・ファイルの入出力か」→ 層 3。「サンプル境界で走るか」→ 層 1。**

- 診断・補完の**計算**を層 2 に置く理由: (a) `get_diagnostics` を MCP から読める片翼状態を作らない（#549 で Fable が捕まえた型の再発防止）(b) 計算はプラグインカタログ（`~/.orbitscore/plugin-catalog.json`）と engine のパーサ（#610 同一パーサ化）に依存し、どちらも層 2 の資産 (c) Monaco の worker を薄く保てる。往復は loopback WebSocket なので補完の体感に影響しない（N0 で実測して閾値を残す）
- 5 本の requestId bridge（拡張側 654 行・09-18）は**層 2 には持ち込まない**。§5 の wire が request id を運ぶので、相関は RPC クライアント 1 本の仕事になる（#757 は**新ラインでは設計で消える**。凍結版では触らない）
- 移す先は「描画に近いか」で決める（`playhead.ts` → WebView / それ以外 → 層 2）。🔴 **「pure = そのまま層 2 へ」ではない**（改訂・§2b）。pure でも **host 側の配線**（child-engine の stdout をパースする経路・ブリッジ）は wire で**消える**側であり、移さない。判定は下の §3.1 の表

### 3.1 🔴 拡張 40 ファイルの行き先（2026-09-18 再測・`wc -l` / `grep -l "from 'vscode'"`）

初版の「19 本 pure → そのまま層 2」を、**3 分類**（**移す** = 層 2 の資産 / **消える** = §5 の wire と層 2 の in-process 化で不要になる host 配線 / **書き直す** = 層 3-b の編集面）に置き換える。行数は 09-18 実測。**依存 / 非依存は `import 'vscode'` の有無で、行き先はそれと一致しない**（pure でも消えるものがあり、依存でも層 2 へ落ちる意味論がある）。

| 行き先 | ファイル（行） | 合計 | 備考 |
|---|---|---|---|
| **移す → 層 2 `packages/session`**（pure 17 本） | MCP 層 8 本: `mcp-server` 346 / `mcp-tools-editor` 288 / `mcp-tools-plugins` 256 / `mcp-types` 230 / `mcp-docs` 190 / `mcp-tools-engine` 158 / `mcp-sdk` 128 / `mcp-registration` 62 ｜ 言語サービス・資産 8 本: `diagnostics-analysis` 495 / `plugin-name-diagnostics` 468 / `wav-analysis` 380 / `plugin-catalog-reader` 349 / `plugin-catalog-completion` 252 / `dsl-completion-context` 228 / `dsl-method-catalog` 77 / `log-ring` 47 ｜ `engine-view` 336（ツリーの整形・pure。WebView へ置く案も可） | **4,290**（1,658 + 2,296 + 336） | `__dirname` 相対でリソースを探す箇所（`mcp-docs.ts` の docs root・`plugin-catalog-reader` のカタログ）は `--docs-dir` 等の起動引数に置き換える（§13 の反証条件） |
| **移す → 層 2（vscode 依存を剥がしてから）**（依存 4 本の**意味論部分**） | `completion-context` 290（補完の計算。`vscode.CompletionItem` 型を自前型へ）/ `agent-handlers` 518 のうち engine 系（`startEngineForAgent` 等）/ `run-selection` 233 のうち `getLineSubject`（`run-selection.ts:27`・§12 補正）/ `plugin-ui-at-cursor` 262 のうち「カーソル下のプラグイン名 → `(receiver,index)` の解決」（#939・DSL 語彙を receiver に誤解決しない規則 #940 も含む） | 約 800（概算・**未実測**） | 残りの editor 系（`openFile` / `setSelection` 等）は**逆方向 `editor.*` リクエストの受け側**（層 3）へ |
| **消える**（pure 8 本 1,499 行・**移さない**）+ **WebView へ**（pure 1 本 273 行） | 5 本のブリッジ 654（request id が wire に乗る・§5.1）｜ `engine-handlers` 530 / `engine-lifecycle` 291 / `engine-startup-runtime` 24（child `cli-audio.js repl` の stdout / stderr / exit をパースして状態に写す経路。層 2 は `InterpreterV2` を**in-process** に持つので stdout パースが存在しない）｜ `playhead` 273 は消えずに **WebView へ**（pure のまま `transport.step` を decoration に写す） | **1,499 が消える / 273 が WebView へ** | 🔴 ただし `engine-lifecycle.ts` の**分類規則**（stderr は ERROR・`transportStatusText`・stale-process guard の判定）は**意味論として層 2 に写す**。ファイルを移すのではなく、規則を `log.line` / `transport.state` の実装に落とす |
| **書き直す → 層 3-b**（依存 11 本） | `extension` 412（activate 配線）/ `engine-process` 683（spawn・stdin 書き込み・`writeCodeToEngine`。Swift の `SessionProcess` + RPC クライアントに置き換わる）/ `engine-view-provider` 292（TreeView）/ `dsl-providers` 417（補完・hover・quick fix の**表示**。quick fix の適用は `editor.editReplace` 経由 = D-4）/ `diagnostics-provider` 171（マーカー）/ `flash-config` 255 / `playhead-decorations` 200 / `plugin-commands` 170 / `mcp-register-command` 217（QuickPick / InputBox。中身の `mcp-registration` は層 2）/ `docs-panels` 130 / `extension-state` 159（host のプロセス状態。層 2 が真実を持つので**持ち越さない**） | **3,106** | §7.4 のパリティ表の母集団。`EDITOR_HOST_AND_APP_SIZE.md` の観察「テキスト編集は 1 つも無い」は 09-18 も成立（`vscode.workspace.onDidChangeTextDocument` は `extension.ts` で購読しているだけで、編集そのものは VS Code のエディタ） |

検算: 4,290（移す・pure）+ 1,303（依存 4 本 = `agent-handlers` 518 + `completion-context` 290 + `run-selection` 233 + `plugin-ui-at-cursor` 262・うち約 800 が層 2 へ）+ 1,499（消える）+ 273（WebView）+ 3,106（書き直す 11 本）= **10,471** ✓（`wc -l` の総計と一致）。**移す量（4,290 + 約 800 ≒ 5,100）は初版の見積り（19 本≒5,000 行）と同じ桁**で、**消える量（約 1,500）が初版では「移す」に混ざっていた**。したがって束 S-mcp / S-editor の概算行数（計画 §2.1）は据え置き、**S-mcp の中身の記述だけ直す**（「`mcp-server.ts` を移動」→「MCP 層 8 本を移動し `OrbitScoreToolHandlers` を層 2 で実装」）。

---

## 4. 🔴 層 2 のプロセス化 — 選択肢と推奨

### 4.1 問い

現行は「拡張 → `node cli-audio.js repl`（stdio）→ daemon」で、層 2 は**拡張プロセスの子**として拡張 1 つに縛られている。ネイティブ化で「クライアント 3 つ・背骨 1 つ」（§3）にするには、層 2 を**どのプロセスに・誰が所有して・どの言語で**置くかを決める。**決めた後に戻れない**のは、所有権（誰が spawn し誰が殺すか）と言語（移植は一方通行）である。

### 4.2 選択肢

| 案 | 形 | 長所 | 短所 | 判定 |
|---|---|---|---|---|
| **A** | Swift アプリの中で JavaScriptCore に TS engine を載せる（in-process） | プロセス 1 つ・IPC 無し | 🔴 UI が落ちると音が止まる（§10「置くべきではない」で撤回済みの型）。JSC に Node API（`fs` / `path` / `ws` / `child_process` / N-API の `@julusian/midi`）が無く 22 ファイル分の shim が要る。拡張と共有できない。改訂: #878 で拡張が **Electron の node**（`ELECTRON_RUN_AS_NODE`）に乗ったのは「Node ランタイムが host に同梱されていた」からで、Swift app にはそれが無い — A を再評価する材料にはならない | **棄却** |
| **B** | **別プロセスの Node**（`packages/session`）。アプリ・拡張・ヘッドレス CLI の**どれか 1 つが所有**する子プロセス | 既存 TS 24,330 行を**そのまま**動かせる。プロセス境界で「UI が落ちても音が続く」。daemon と同じ起動流儀（ready 行）で揃う | Node ランタイムを `.app` に同梱する必要（W-22 と同じ判断）。所有者が死ぬとセッションも終わる | ✅ **推奨** |
| **C** | 別プロセスの Node を**ユーザー常駐サービス**にし、クライアントは既知のソケットで発見して attach（誰も所有しない） | 「エディタを閉じてもエージェントが動く」を最も素直に満たす。複数アプリインスタンスで 1 セッション | 🔴 孤児・二重起動・発見・認証の**問題クラスを新設**する（このリポジトリの実測クラス: #624 二重 daemon・#779 shm 孤児・memory `orphan-daemon-pins-coreaudio-context`）。macOS の Unix ソケットパス上限 103 文字（#830 で実測）も踏む | **第 1 リリースでは採らない**（§14 (1)・後から B → C へは足せる。C → B は戻れない） |
| **D** | Rust プロセスに JS エンジン（`rquickjs` / `deno_core`）を埋め込む | Node を捨てられる | 🔴 N-API の native addon（`@julusian/midi`）が載らない / `ws` `fs` `child_process` の ops を自作 / 検証済み挙動をやり直す。裁定 §3 も「Node を完全に捨てたい場合の中間案」 | **棄却（今は）**。B で境界を固定すれば後から差し替えられる |
| **E** | 層 2 を Rust へ移植 | 最終形として最も速い | 🔴 12,600 行の意味論移植。裁定 §3「必要が生じたときに」 | **棄却（今は）** |

### 4.3 推奨 = B（app 所有の Node 子プロセス）+ ヘッドレス host。理由

1. **所有権を 1 つに固定すると、故障モードが今日と同じクラスに収まる。** 今日も engine は拡張の子で、daemon は engine の子（`daemon-client.ts:905`）。B はその親を「拡張」から「アプリ or CLI」に置き換えるだけで、**新しい生存管理を発明しない**。C が持ち込む孤児・発見・二重起動は、このリポジトリが 2026-09 に**何度も踏んだ**クラス（上表）で、第 1 リリースで新設する理由が無い
2. **「エディタを閉じてもエージェントが動く」は B でも満たせる。** ヘッドレス host（`orbitscore session --port N --mcp`）を LLM の入口として置く（D-3）。「アプリを閉じた後もセッションを残す」（detach）だけが C でしか出来ないが、それが要るかは owner 裁定（§14 (1)）。B → C は後から**足せる**（発見機構を足すだけ）が、C → B は所有権を後から縛れないので戻れない。**戻れる側に倒す**
3. **言語は変えない。** 境界（§5）を先に固定すれば中身の言語は後で変えられる（裁定 §3）。MIDI スケジューラ・transport を Rust へ落とすのは §9 の「実際に聞こえているか」の実測後（§4.6）

### 4.4 ライフサイクル（B の具体）

```
host（OrbitStudio.app / VS Code 拡張〔凍結・別 host〕/ orbitscore session CLI）
  └─ spawn: node <bundle>/session/dist/cli.js session --port <N|0> [--mcp] [--docs-dir …]
        stdout 1 行目: {"ready":true,"port":<bound>,"protocol_version":"1.0"}   ← daemon の StartupReady と同型
        stderr: 起動失敗は {"ready":false,"error":{code,message}}               ← daemon の StartupError と同型
  └─ session が spawn: orbit-audio-daemon（既存 rust-engine-player.ts・変更なし）
```

- **1 host = 1 session = 1 daemon**。host が終了する時は `session.shutdown` を送って待ち、応答が無ければ SIGTERM → SIGKILL。session は自分の daemon を同じ順で畳む（既存 `cli/shutdown.ts` の経路）。**host が SIGKILL で死んだ時に session と daemon が残らない**ことを、gated `native` の teardown で PID オラクル（既存 `orbitAudioDaemonPids()` を helper へ）により確認する（PR-E8 の狭いスライスと同じ形）
- **UI（WebView）のリロード・クラッシュでセッションは生き残る**（層 3-b の中で WebView だけが落ちる）。Swift シェル自体が落ちたら host が死ぬのでセッションも終わる — これは B の制約であり、C を採らない代償として明記する
- **再接続**: WebView は RPC クライアントなので、リロード後は同じ port へ再ハンドシェイクし、`session.getState` で状態（engine 稼働・transport・開いている document 一覧）を取り直す。**状態の真実は層 2**なので、クライアントは何も持ち越さなくてよい
- **ポート**: 1 リスナー・1 ポート（`--port 0` で ephemeral）。同じリスナーの `/rpc`（WebSocket）と `/mcp`（Streamable HTTP）に多重化する（§5.2）。認証は**しない**（daemon の `127.0.0.1:0` と現行 MCP の `127.0.0.1:<port>` と同じ前提。`/mcp` が無認証で `evaluate` を開けている以上、`/rpc` にだけ token を付けても意味が無い。変えるなら両方同時・§14 に載せない = 現状踏襲）

### 4.5 ヘッドレス host = `orbitscore session`

`packages/engine` の CLI（`parse-arguments.ts`: `repl` / `play` / `midi-run` / `test-sound` …）に **`session` サブコマンドを足す**のではなく、`packages/session` 側の `cli.ts` を入口にする（§8）。理由: `packages/engine` は凍結版の拡張が `engine/dist/cli-audio.js repl` として同梱・実行する（`extension.ts:1092`）ので、そのファイルに新ラインの機能を足すと**凍結版のビルド成果物が変わる**。

### 4.6 段階移行（言語を変える時の順序・今は決めない）

裁定 §3「MIDI スケジューラと transport だけ先に Rust へ」は **§9「5 ms ポーリングが実際に聞こえているか」の実測が先**。実測の手段は既に在る（capture WAV のオンセット位置・`tests/e2e/helpers/capture-windows.ts`）。聞こえる差が出たら、`ScheduleEvents`（doc 428・PR-Q）が層 1 側の受け皿なので、そこに乗せる。**本設計はその判断を予約するだけ**で、`packages/session` の境界（§5）はそれによって変わらない。

`AUDIO_ENGINE_CORE_ARCHITECTURE.md` §5 は musical timing を Rust へ移す引き金を「**複数のフロントが同じ timing を使う必要が出た時**」としていた。本書の形ではフロントが 3 つになっても **timing を持つ層 2 は 1 プロセス**で全フロントを受けるので、**この引き金は引かれない**。残る引き金は §9 の実測（聞こえるか）だけである。

---

## 5. 🔴 セッションプロトコル — 作り直す

### 5.1 選択肢

| 案 | 形 | 長所 | 短所 | 判定 |
|---|---|---|---|---|
| **P-A** | 現行 `//#` メタ行 + stdout 行を**流用**し、Swift 側でも同じ文字列パースを実装 | 層 2 の変更ゼロ | 🔴 1 チャンネル（stdin/stdout）なので**複数クライアントに配れない**。相関ブリッジ 5 本（#757）と chunk 境界の欠陥（#773 / #777）を Swift でもう一度作ることになる。型が無い（スキーマから生成できない） | **棄却** |
| **P-B** | **型付き双方向 JSON-RPC 2.0 over WebSocket**（`/rpc`）。リクエスト id・メソッド・params・**サーバ → クライアントのリクエスト**（エディタ操作の逆方向）・通知（イベント） | request id が wire にあるので相関ブリッジが消える。複数クライアント可。スキーマ 1 本から TS / Swift / Rust を生成。daemon protocol v0.2 と同じ流儀（handshake + `protocol_version` + `capabilities`） | プロトコルを設計・維持する費用。**一方通行**（クライアントが増えた後は変えにくい） | ✅ **推奨** |
| **P-C** | **MCP そのものを GUI のプロトコルにする**（アプリは MCP クライアントの 1 つ） | 表面が 1 つ | 🔴 `open_file` / `run_selection` / `set_selection` / `edit_replace` / `get_document_text` / `save_file` / `get_editor_state` / `configure_flash` は**サーバがエディタに頼む**操作で、MCP はサーバ → クライアントのツール呼び出しを持たない（sampling / elicitation は別物）。playhead の `[STEP]`（ms 単位・高頻度）を MCP 通知で運ぶ設計は無い。`get_log` は 500 行窓のポーリング | **棄却**。ただし **MCP ツールは P-B のメソッドの薄い写し**にする（D-4） |
| **P-D** | LSP を層 2 に実装し Monaco を LSP クライアントにする | 補完・診断の型が業界標準 | Monaco に LSP クライアントは同梱されない（`monaco-languageclient` は VS Code の shim を持ち込む）。LSP は評価・transport・プラグイン UI を運べないので**結局 P-B も要る** | **棄却**。document 同期のメソッド形だけ LSP に倣う（§5.5） |

### 5.2 P-B の骨格

```
transport   : WebSocket（ws://127.0.0.1:<port>/rpc）。同じ HTTP リスナーの /mcp が MCP（Streamable HTTP・現行のまま）
framing     : JSON-RPC 2.0。1 テキストフレーム = 1 メッセージ（chunk 境界の問題は WebSocket のフレーミングで消える・#773 のクラスを構造で潰す）
handshake   : 接続直後にサーバが {"jsonrpc":"2.0","method":"session.hello","params":{protocol_version:"1.0",session_version,capabilities:[…]}}
              クライアントは session.attach({client:{name,version}, capabilities:["editor"|"observer"|…]}) → {clientId}
versioning  : protocol_version は "MAJOR.MINOR"。MINOR = 追加のみ（新メソッド・新省略可能フィールド）。MAJOR = 破壊。
              🔴 不一致は黙って縮退せず attach を拒否する（strict・#136 の原則）。app と session は同じ .app に同梱されるので
              実運用では常に一致し、不一致は「ビルドの混線」= バグとして早く見える
schema      : protocol/session/v1/*.schema.json（JSON Schema 2020-12）を単一の真実にし、TS 型・Swift Codable を生成（§5.8）
```

**なぜ WebSocket か（stdio / Unix ソケットとの比較）**: stdio は親しか繋げない（複数クライアント不可）。Unix ソケットは macOS のパス上限 103 文字を踏む（#830 で実測・`orbitstudio-mcp-gated.spec.ts:103`）。TCP loopback は daemon（`server.rs:19`）と MCP（`mcp-server.ts`）が既に使っており、Swift は `URLSessionWebSocketTask`・WebView は `WebSocket`・Node は `ws`（既存依存）で**新しい依存が 1 つも増えない**。

### 5.3 メソッド一覧（v1・現行表面の写像）

名前空間は `session.* / engine.* / audio.* / plugin.* / editor.* / docs.*`。**現行の 26 MCP ツール + 6 メタ行 + stdout の 3 系統をすべて写す**ことで、不在（写し漏れ）を表で証明する。

| 現行（拡張 / メタ行 / MCP） | v1 メソッド（向き） | 備考 |
|---|---|---|
| `//#evalMark` + コード送信 / `evaluate_orbitscore` / `run_selection` の後半 | `session.evaluate({code, documentDirectory?, source:"human"\|"agent", frame?})` → `{ok, diagnostics[]}`（C→S） | **request id が evalMark の役目を持つ**ので evalMark は消える（裁定 §3）。1 リクエスト = 1 `execute()`（doc 694 のフレームと同じ意味論） |
| `//#evalBegin` / `//#evalEnd`（改訂: 09-18 の凍結版に**実在**する。`repl-mode.ts:108-115`・#611 §5.7・O-surface） | **無し**（`session.evaluate` の 1 リクエストが 1 フレーム） | 凍結版で 1 評価 = `evalBegin … evalEnd` に括る理由（chunk 境界で評価が割れる・カーソル規則の自己修復）は、WebSocket の 1 フレーム = 1 メッセージ（§5.2）で**構造的に消える**。wire 上には出ない |
| `//#documentDirectory` + DSL 注入（`extension.ts:3117-3149`） | `session.evaluate` の `documentDirectory` | 帯域外の注入が要らなくなる。import の基準（IM.6）は params で確定 |
| `start_engine` / `stop_engine` / `//#getEngineState` / `get_engine_state` | `engine.start({captureWav?, audioDevice?, debug?})` / `engine.stop()` / `engine.getState()` | 既存 `startEngineForAgent` 等の中身を移す |
| `//#selectAudioDevice` / `select_audio_device` / `list_audio_devices` | `audio.selectDevice({device})` / `audio.listDevices()` | |
| `//#savePluginState` / `save_plugin_state` | `plugin.saveState({sequence,index})` | |
| `//#pluginUi` / `open_plugin_ui` / `close_plugin_ui` | `plugin.openUi({receiver,index,expectedName?})` / `plugin.closeUi(…)` | ウィンドウは child プロセスが所有（UIH spec）。アプリは開閉を**要求するだけ** |
| `list_plugins` / `rescan_plugins` | `plugin.list()` / `plugin.rescan()` | `plugin-catalog-reader.ts`（pure）を層 2 へ |
| `get_log` | `session.getLog({lines})` | `log-ring.ts`（pure）を層 2 へ。GUI のログパネルも同じ ring を読む |
| `analyze_audio` | `audio.analyze({wavPath, windowMs, perChannel})` | `wav-analysis.ts`（pure）を層 2 へ |
| `get_dev_doc` / `search_dev_docs` | `docs.get({path})` / `docs.search({query})` | 同梱 docs の所在は起動引数 `--docs-dir` |
| `register_mcp_server` | `session.registerMcp({scope,port})` | `mcp-registration.ts`（pure）を層 2 へ |
| `get_diagnostics` | `editor.getDiagnostics({uri})`（C→S。**計算は層 2**） | 層 2 が同期済み document から計算（§5.5） |
| 補完（`registerCompletionItemProvider` 3 箇所） | `editor.complete({uri, position})`（C→S） | `completion-context.ts` の vscode 依存を外して層 2 へ。Monaco の `CompletionItemProvider` は結果を描くだけ |
| `open_file` / `set_selection` / `run_selection` / `edit_replace` / `get_document_text` / `save_file` / `get_editor_state` / `configure_flash` | **`editor.*` の逆方向**（S→C）: `editor.openFile` / `editor.setSelection` / `editor.runSelection` / `editor.editReplace` / `editor.getDocumentText` / `editor.saveFile` / `editor.getState` / `editor.configureFlash` | 層 2 が `editor` capability を持つクライアントへ**リクエストを送る**。無ければ `NO_EDITOR_ATTACHED`（D-3） |
| `[STEP] seq argPath atEpochMs`（stdout） | 通知 `transport.step({seq, argPath, atEpochMs})`（S→C） | 全クライアントへ broadcast。WebView が `playhead.ts` で decoration に写す |
| `[ERROR] …`（stderr）/ `outputChannel.appendLine` | 通知 `log.line({level, text, ts})`（S→C） + ring | stderr は ERROR に分類（memory `stderr-is-classified-as-error`）を**層 2 の中で**行い、クライアントは分類しない |
| `{"engineState":…}` の push・status bar・`PluginUiClosed` 等の daemon event | 通知 `engine.state({…})` / `plugin.uiClosed({…})` / `transport.state({playing})` | status bar の「Playing / Ready」は `transport.state` を描くだけ（#527 の取り違えクラスは引数付き 1 本に畳んで潰す） |
| `force_kill_scsynth` / `orbitscore.forceKillScsynth` | **無し** | 改訂: ✅ **既に無い**（#502・2026-09-10）。09-18 の 26 ツールに含まれない（`grep -rn force_kill_scsynth packages/vscode-extension/src` = 0 件） |
| `open_plugin_ui_at_cursor` / `orbitscore.openPluginUiAtCursor`（改訂: #939・PR #941・4.2.0 で追加） | `plugin.openUiAtCursor()`（C→S）— 層 2 が `editor.getState`（同期済みの選択位置・§5.5）から**カーソル下のプラグイン名を解決**し、`plugin.openUi({receiver,index})` を呼ぶ | 解決規則（DSL 語彙を receiver に誤解決しない・#940 の `96fdc56d`）は**層 2 に置く**（GUI と MCP で同じ結果 = D-4）。エディタは選択位置を同期しているだけで、逆方向リクエストは要らない |
| `orbitscore.reloadWindow` / `startEngineDebug` / `openWalkthrough` | **未決**（§14 (11)） | VS Code 固有か、`engine.start({debug:true})` の糖衣か |

### 5.4 エディタ逆方向の契約（P-B を採る決め手）

- `editor` capability を宣言したクライアントは、attach 時に**開いている document を同期**する（§5.5）。層 2 は「今どの document が開いていて、選択がどこか」を**クライアントに聞かずに知っている**（`editor.getState` は同期済みの写しを返す）
- `editor.runSelection` は**クライアントが選択テキストと位置を返すだけ**で、subject-block の解決（`extension.ts:2790-2815` の `getLineSubject` と複数行検出）は**層 2 が行う**（§12 補正）。したがって VS Code 版とアプリ版で「⌘Enter で何が評価されるか」がずれない
- `editor` クライアントは**同時に 1 つまで**（2 つ目の attach は `EDITOR_ALREADY_ATTACHED`）。複数エディタの需要は §14 (8)
- 逆方向リクエストにもタイムアウトを置く（現行 bridge の timeout と同じ役割）。期限切れは `EDITOR_TIMEOUT` として MCP 呼び出し元へそのまま返す（黙らない）

### 5.5 document 同期（LSP の形だけ借りる）

`editor.didOpen({uri, text, documentDirectory})` / `editor.didChange({uri, version, changes[]})` / `editor.didClose({uri})` / `editor.didChangeSelection({uri, range})`（C→S・通知）。層 2 は document の写しを持ち、診断（`diagnostics-analysis.ts` + `plugin-name-diagnostics.ts`）を計算して `editor.diagnostics({uri, items[]})` を push する。**`get_diagnostics`（MCP）と Monaco のマーカーは同じ計算結果**を見る。

### 5.6 同時性（§12 追加の未検証項目・本書の答え）

| 規則 | 内容 | 理由 |
|---|---|---|
| **評価は FIFO・1 本** | すべてのクライアントからの `session.evaluate` は到着順に 1 本のキューへ入り、1 件ずつ `execute()` される。ロックも所有権も無い | Node の単一イベントループが今日も同じ直列性を与えている（`repl-mode.ts` の FIFO・`//#evalMark` のコメント）。プロセス境界で失われるのは「同じプロセスにいる暗黙の直列性」であって、**キューを 1 本に固定すれば復元できる** |
| **後勝ち** | 同じシーケンスへ人間と LLM が続けて評価すれば、後の評価が勝つ。DSL のライブ後勝ち（SC.10）と同じ | 人間が 2 回評価した時と区別しない = 新しい意味論を作らない |
| **出自を記録** | `session.evaluate` は `source`（human / agent）と `clientId` を持ち、`.orbslog` の frame 属性（doc 694 §4.1 の `evalSource`）に写す。`log.line` にも出自を付けて全クライアントへ broadcast | 「誰の評価で音が変わったか」が後から追える。GUI のログに LLM の評価が見える |
| **エディタは 1 つ** | §5.4 | 「どのエディタに `open_file` するか」の問いを第 1 リリースでは持たない |

### 5.7 メタ行との対応が**全射**であることの確認

§5.3 の表は、`grep -rho '//#[a-zA-Z]*' packages/vscode-extension/src packages/engine/src | sort -u`（改訂: **8 種** = `documentDirectory` / `evalBegin` / `evalEnd` / `evalMark` / `getEngineState` / `pluginUi` / `savePluginState` / `selectAudioDevice`）・`registerTool`（**26 個**・`mcp-tools-editor` 12 + `mcp-tools-engine` 7 + `mcp-tools-plugins` 7。名前は `analyze_audio` / `close_plugin_ui` / `configure_flash` / `edit_replace` / `evaluate_orbitscore` / `get_dev_doc` / `get_diagnostics` / `get_document_text` / `get_editor_state` / `get_engine_state` / `get_log` / `list_audio_devices` / `list_plugins` / `open_file` / `open_plugin_ui` / `open_plugin_ui_at_cursor` / `register_mcp_server` / `rescan_plugins` / `run_selection` / `save_file` / `save_plugin_state` / `search_dev_docs` / `select_audio_device` / `set_selection` / `start_engine` / `stop_engine`）・stdout の 3 系統（`✓` / `[STEP]` / 1 行 JSON 5 種）・stderr（`[ERROR]`）・コマンド **16**（`package.json` `contributes.commands`）を**列挙して 1 行ずつ写した**。`✓` だけは `session.evaluate` の応答に吸収され、`evalBegin` / `evalEnd` は WebSocket のフレーミングに吸収されて、対応する行を持たない。**漏れの証明は列挙表そのもの**（memory `absence-claims-need-exhaustive-enumeration`）。🔴 列挙は凍結タグ（4.2.0）で固定する — 凍結版は以後 bug fix しか入らないので、この表が動くのは新ラインが RPC メソッドを**足す**時だけ。

### 5.8 スキーマと生成（単一の真実）

- 置き場: `protocol/session/v1/`（§8）。形式は **JSON Schema 2020-12**。理由: TS（`json-schema-to-typescript`）・Swift（`quicktype`）・Rust（`typify` / `schemars` の逆）へ**言語をまたいで**生成できる形式はこれしか無い。TypeScript や zod を正本にすると Swift 側は手書きになる
- 生成物は**コミットする**（`protocol/gen/ts/` `protocol/gen/swift/`）。CI は「生成し直して差分ゼロ」を検査する（`npm run protocol:check`）。理由: Xcode / SwiftPM のビルドに Node を要求しない
- 🔴 **ツールの選定は N0-b の spike で確定**（本書は候補を挙げるだけ・未検証）。spike の受け入れ: 3 メッセージ（`session.evaluate` 要求 / 応答 / `transport.step`）が TS ↔ Swift で往復して等しい
- `surfaces` 拡張キー: 各メソッドに `"x-surfaces": ["gui","mcp"]` を必須にし、D-4 の検査が読む

---

## 6. MCP サーバの置き場 = 層 2

- 改訂（#887 後）: **MCP 層 8 ファイル 1,658 行**（`mcp-server` / `mcp-tools-{editor,engine,plugins}` / `mcp-types` / `mcp-docs` / `mcp-sdk` / `mcp-registration`・すべて pure・§3.1）を `packages/session/src/mcp/` へ**ファイル移動**する。ツール登録は `OrbitScoreToolHandlers`（`mcp-types.ts:176-224`）という**インタフェース 1 本**を受け取る形に既になっているので、層 2 の仕事は **このインタフェースを §5.3 の RPC メソッドで実装する**こと（`agent-handlers.ts` 518 行の `*ForAgent` を書き換えるのではなく、**同じ型を別の実装で満たす**）。ツール名・引数・戻りは**変えない**（gated suite がそのまま通ることが D-1 / D-2 の前提）。`registerMcpServer?` が optional である設計（`mcp-types.ts:217-223`「hosts that can register themselves」）は headless host（D-3）にそのまま効く
- 🔴 `mcp-docs.ts` の docs root（`resolveDocsRoot(baseDir)` = `baseDir/sites/dev/.vitepress/dist`・`mcp-docs.ts:29-36`）は `mcp-server.ts:137-138` で `__dirname/../../..` を渡している = **モノレポ前提**。層 2 では起動引数 `--docs-dir`（§4.4）に置き換える。同梱の中身は別冊 [`848-docs-structure-design.md`](848-docs-structure-design.md) §6
- `/mcp` は `/rpc` と同じリスナー。`--mcp` を付けた時だけ有効（今日の「port が 0 なら立てない」と同じ既定）。アプリの環境設定「MCP ポート」→ session の起動引数へ
- **MCP ツール = RPC メソッドの薄い写し**（D-4）。ツール固有のロジック（`ok` の意味・`get_log` の窓）は今日のまま
- LLM が第一級ユーザーであることの帰結: **アプリを起動しなくても** `orbitscore session --mcp` で同じツール集合に到達できる（D-3）。Claude Code への登録（`.mcp.json`）は `session.registerMcp` が書く

---

## 7. GUI の設計制約とアプリの構成

### 7.1 Swift シェルの面積（裁定 2.2「シェルだけ」）

| 責務 | AppKit | 備考 |
|---|---|---|
| ドキュメント | `NSDocument` サブクラス（`.orbs`・UTF-8） | open / save / autosave / 未保存確認 / 最近使った書類は**標準で付いてくる**（裁定 2.2 の根拠） |
| ウィンドウ | `NSWindowController` + タブ（`NSWindow.tabbingMode`） | 1 document = 1 window。パネル（Engine / Log / Catalog / Docs）は**サイドバー**（`NSSplitViewController`）で同じウィンドウ内 |
| メニュー・キー | メニューバー・⌘Enter = `runSelection`（`package.json` の唯一のキーバインドと同じ） | ⌘Enter は WebView 内の Monaco keybinding が先に受け、変換中（IME composition）は評価しない（D-6） |
| 環境設定 | `NSWindow` + 設定 10 項目の写像（§7.4） | `UserDefaults`。値は session の起動引数か RPC で渡す |
| WebView | `WKWebView` × 1（エディタ + パネル） | `loadFileURL` で同梱 bundle。`WKScriptMessageHandler` は**document の入出力だけ**に使う（§7.3） |
| 層 2 | spawn・ready 行の待ち・監視・shutdown（§4.4） | Swift は RPC を**ほぼ話さない**（§7.3） |
| プラグイン UI | 何もしない | child プロセスの `NSWindow`（UIH spec）。アプリは `plugin.openUi` を頼むだけ |

**概算**: Swift 2,000〜4,000 行（裁定 §2.2「数千行のオーダー」）。**未実測**。N2 で実測して計画に戻す。

### 7.2 GUI 操作 → DSL テキスト（地図 §1 #681・memory `dsl-correctness-is-editor-ux`）

- **譜面に効く操作**（エフェクトを差す・ゲインを変える・出口を足す）は GUI で行っても**エディタのテキストを書き換えて評価する**（`editor.editReplace` と同じ経路を GUI 内部で使う）。GUI は「テキストのもう一つの編集面」であり別モデルを持たない
- **セッションに効く操作**（デバイス選択・engine の起動停止・MCP ポート）は RPC メソッド（`audio.selectDevice` 等）で、MCP にも同じツールがある（D-4）
- 🔴 **例外を作らない**: 「GUI だけの近道」は D-4 の検査で red になる

### 7.3 ライブコーディングに確認・停止を挟まない（memory `live-coding-forbids-workflow-interruptions` / `ui-windows-only-open-and-close-by-user`）

| 規則 | 実装の形（構造で守る） |
|---|---|
| 評価経路にモーダルを出さない | `session.evaluate` を呼ぶ Swift / TS の経路に `NSAlert` / `window.confirm` を**呼べる API が無い**（評価は WebView の TS が RPC を直接叩く。Swift は介在しない・§7.3 下段） |
| 失敗は黙らず、止めずに伝える | `log.line` とエディタの診断（赤線）。#385 の「沈黙」も #614 の「ok だけ」も作らない |
| ウィンドウは勝手に開閉しない | プラグイン UI は `plugin.openUi` を**ユーザー操作か LLM の明示要求**でだけ送る。engine のクラッシュや respawn でパネルを自動で開かない。例外は「対象の消滅」（child が死んだ時に child 自身の窓が消える）だけ |
| 起動時に何も聞かない | プラグインの読み込みは DAW と同じ（memory `plugin-guarantee-belongs-at-scan-not-at-play`）。信頼ダイアログ相当を持たない |

**RPC クライアントは WebView の TS**（Swift ではない）— 理由: 補完・診断の描画・playhead・ログパネル・カタログ表示はすべて既存 TS 資産の延長で、Swift を経由すると `WKScriptMessageHandler` の往復が 1 段増えるだけ。Swift シェルは document / window / menu と層 2 の**プロセス管理**に限る。WebView が落ちてもセッションは残る（§4.4）。🔴 `file://` origin から `ws://127.0.0.1` へ接続できるかは **N0-a で実測**（できなければ WebView を `http://127.0.0.1:<port>/app/` から配信する代替がある = 層 2 の HTTP リスナーが静的ファイルも返す。どちらでも設計は変わらない）。

### 7.4 表面のパリティ（拡張の `contributes` → アプリ）

| 拡張の表面 | アプリでの置き場 | 分類 |
|---|---|---|
| `toggleEngine` / `stopEngine` / `restartEngine` | Engine パネルのボタン + メニュー「Engine」 | native 必須 |
| `runSelection`（⌘Enter） | Monaco keybinding → `editor.runSelection` 相当を WebView 内で完結（選択テキストを `session.evaluate` へ。subject-block は層 2） | native 必須 |
| `selectAudioDevice` / `engineViewSelectDevice` / `listAudioDevices` | Engine パネル（`engine-view.ts` の pure なノード整形を WebView で描く） | native 必須 |
| `configureFlash` + 設定 `flash*` 4 項目 | 環境設定（flash は Monaco の decoration で実装） | native 必須 |
| `rescanPlugins` / `browsePlugins` | Catalog パネル | native 必須 |
| `openPluginUiAtCursor`（改訂: #939・4.2.0・右クリック → カーソル下の 1 つの UI）+ `open_plugin_ui_at_cursor` | Monaco のコンテキストメニュー → `plugin.openUiAtCursor()`（解決は層 2・§5.3）。🔴 **ネイティブ版で初めて右クリックが自動テストできる**（memory `native-app-unlocks-gui-test-automation`・拡張版では computer-use が IDE を click tier に固定するため手動だった） | native 必須 |
| `registerMcpServer` + 設定 `mcpServer.port` | 環境設定「MCP」+ メニュー | native 必須 |
| `openDocs` / `openDevDocs` / `openDevDocsPanel` + Learning view | Docs パネル（同梱 docs を WebView で表示。`get_dev_doc` と同じ資産） | native 必須（範囲は §14 (11)） |
| `startEngineDebug` + 設定 `engineDebug` | 環境設定「デバッグログ」= `engine.start({debug})` | native 必須（表面は簡素化） |
| `reloadWindow` / `openWalkthrough` | **VS Code 固有** | 🔴 §14 (11) |
| `forceKillScsynth` + 設定 `scsynthPath` / `engine` | **無し**（SC 削除 #502・改訂: 09-18 の `contributes` に既に無い。設定は 8 項目） | not-applicable |
| 設定 `audioDevice` / `playheadPalette` | 環境設定 | native 必須 |
| status bar「🎵 OrbitScore: Stopped / Playing」 | ウィンドウ下部のステータス（`transport.state` を描く） | native 必須 |
| OutputChannel「OrbitScore」 | Log パネル（`session.getLog` + `log.line`） | native 必須 |
| Diagnostics（赤線）/ 補完 | Monaco マーカー / `CompletionItemProvider`（計算は層 2） | native 必須 |
| TextMate 文法 `orbitscore-audio.tmLanguage.json` | 🔴 Monaco は TextMate をそのまま読まない。`monaco-textmate` + `vscode-oniguruma`（WASM）で流用するか、Monarch へ書き直すかは **N0-a の spike で決める**（判定基準: 既存文法との一致を 20 譜面のトークン列で機械比較） | native 必須 |
| `capabilities.untrustedWorkspaces` | 概念が無い（アプリは常に信頼して開く = DAW と同じ・656 §16 (1)） | not-applicable |
| （VS Code が無料で提供していたもの・`EDITOR_HOST_AND_APP_SIZE.md` §1.2）検索 / 置換・undo / redo・マルチカーソル | Monaco 標準機能（`ELECTRON_APP_PLAN.md` 5.2 の列挙どおり。自前実装なし） | native 必須（Monaco が持つ） |
| 同・複数ファイル・最近使った書類・未保存確認 | `NSDocument` + ウィンドウのタブ（§7.1） | native 必須 |
| 同・設定 UI・キーバインド | 環境設定（設定 10 項目）・メニューの accelerator。キーバインドの**カスタマイズ UI は作らない**（⌘Enter 固定） | native 必須（範囲は §14 (11)） |
| （`ELECTRON_APP_PLAN.md` 5.4 の列挙）ステータスバーの **BPM** とカーソル位置 | `transport.state` に tempo を含めて描く / Monaco の cursor イベント | 追加候補（拡張には無い表面。台帳では `not-applicable`、実装は A-panels の余力で） |

---

## 8. ディレクトリレイアウト（確定案）

```
rust/crates/                     層 1（現状のまま・裁定 2.4）
packages/engine/                 DSL 意味論のライブラリ + 凍結版 REPL 入口（cli-audio.js repl）。🔴 新ラインの機能は足さない（§4.5）
packages/session/                層 2 のプロセス host（新設）:
  src/cli.ts                       `orbitscore session --port --mcp --docs-dir`
  src/rpc/                         JSON-RPC over WebSocket（サーバ・逆方向リクエスト・イベント）
  src/mcp/                         mcp-server.ts（拡張から移動）・mcp-registration.ts
  src/services/                    diagnostics / completion / catalog / log-ring / wav-analysis / subject-block（拡張の pure モジュールを移動）
  src/host/                        engine ライフサイクル（既存 rust-engine-player.ts を使う）・document 写し
packages/vscode-extension/       層 3-a（凍結・bug fix のみ）
apps/OrbitStudio/                層 3-b（新設）:
  Package.swift                    SwiftPM（executable target）。`.xcodeproj` は作らない（§11）
  Sources/OrbitStudio/             AppDelegate / Document / WindowController / SessionProcess / Preferences
  Web/                             Monaco + RPC クライアント + パネル（TS・esbuild で dist/ へ）
  Resources/                       Info.plist・entitlements・icon
  scripts/make-bundle.sh           .app 組み立て（node・session dist・rust binaries・Gain.clap・Web/dist を Contents/Resources へ）
protocol/                        単一スキーマと生成物（新設）:
  session/v1/*.schema.json         正本
  gen/ts/  gen/swift/              生成物（コミットする・`npm run protocol:check` で差分ゼロを検査）
```

- **`packages/engine` は rename しない**（§14 (2)・推奨「しない」）。理由: 凍結版の拡張が `engine/dist/cli-audio.js` を同梱・実行しており（`extension.ts:1092`）、rename は凍結版のビルド経路を触る。層 1 / 2 の曖昧さは **`packages/session` を層 2 の名前として立てる**ことで解消する（「engine = DSL ライブラリ」「session = 層 2 プロセス」「orbit-audio-* = 層 1」）
- `CLAUDE.md` を層ごとに置く（裁定 §3）: `packages/session/CLAUDE.md` / `apps/OrbitStudio/CLAUDE.md` / `protocol/CLAUDE.md`。中身は「この層に置かないもの」（§3 の右列）だけを書く
- SwiftPM を採る理由: `swift build` が CLI で回り、委譲先（Codex）がコンパイルまで確認できる。`.xcodeproj` は差分がノイズで、レビューが読めない。署名・entitlements は `make-bundle.sh` → `codesign` で行い、Xcode を要求しない。Instruments 等で `.xcodeproj` が要る日が来たら `swift package generate-xcodeproj` 相当で**生成物**として扱う

---

## 9. 配布（ステージ 8 の再定義・裁定 §12.3）— `656-release-design.md` からの**差分だけ**

🔴 **配布は既に設計されている**（`656-release-design.md`・2026-09-03・§0 に裁定 10 件・§16 に owner 回答 8 件）。本節はそれを再設計せず、**ネイティブ app で変わる差分だけ**を書く。変わらないものは 656 を参照する。

### 9.0 656 の裁定・回答の仕分け

| 656 の項目 | 内容 | ネイティブ app での扱い |
|---|---|---|
| §0 裁定 1・2 | `.app` と `.vsix` の**両方を出す**。`release.yml`（vsix 専用）は生きる。app のジョブを足す | **引き継ぐ**。`.vsix` は凍結版（`release.yml` はそのまま）。app のジョブは `release-app.yml`（§9.3） |
| §0 裁定 3 / §16 (6) | Marketplace / Open VSX は**未決**。GitHub Releases だけで成立 | **引き継ぐ**（凍結版の話・本書は触らない） |
| §0 裁定 4 | 順序 #659 → #656 → #498 | **引き継ぐ**（束 R-app の中の順序。#498 Sentry は R-app の後・656 §7 のまま） |
| §0 裁定 5 | #385 は `must-fix` | 凍結版の話。ネイティブ app には **trust の概念が無い**（§7.4） |
| §0 裁定 6 | 未署名の `.app` は quarantine で開けない。署名・公証は配布の前提 | **引き継ぐ** |
| §0 裁定 7 | 順序 **build → trim → sign → notarize → staple** | trim（ソースマップ・拡張の取捨）は**失効**（Electron が無い）。「**署名の後にバンドルを触らない**」原則は**引き継ぐ**（§9.2） |
| §0 裁定 8 | 自作エディタは採らない・VSIX + 軽量化 VSCodium | **失効**（裁定 2.2） |
| §0 裁定 9・10 | per-PR macOS ランナーは回さない・手元が `bundle-macos.sh` + `--ignored` の唯一の実行経路 | **引き継ぐ**（§9.4。Swift のコンパイルも同じ扱い） |
| §4 `make-local-release.sh` の 12 段 | preflight / build / package / verify-vsix / stage-app / trim / embed / sign / notarize / smoke / manifest / prune | **段の骨格を引き継ぎ、中身を app 版に差し替える**（§9.2 の表）。段 3・4（vsix）と段 5〜7（VSCodium への埋め込み）が失効し、代わりに `make-bundle.sh`（§8）が入る |
| §4.3 成果物の名前 `<stamp>-<sha>-app/` / `latest` / `MANIFEST.md` | | **引き継ぐ** |
| §4.4 バージョン同期「**正本 = 拡張の `version`**」（§16 (7) 裁定 A） | app 版 = 拡張版 が定義として成立していたから | 🔴 **失効**。ネイティブ app は拡張と別物で、版が一致する根拠が無い。**app の版の正本を決め直す**（§14 (14)）。preflight で「tag = 正本の版」を強制する規則の**形**は引き継ぐ |
| §4.5 `verify-vsix.sh` | `.vsix` の中身検査 6 項目 | **引き継ぐ + app 版を足す**: `verify-app.sh <OrbitStudio.app>` が同じ 6 項目（daemon / child 5 / plugin-scan / engine 依存 / `Gain.clap` / `cli.js`）+ **node の実在**を `Contents/Resources` に対して検査する。**同じ検査を 2 実装にしない**ため、両スクリプトは検査項目の共通部分を 1 ファイルから読む |
| §5.1 署名対象 1〜8 + 10（`.node`） | 7 バイナリ + `Gain.clap` + `@julusian/midi` の `.node` | **引き継ぐ + 2 つ足す**: **同梱 node**（W-22）と **Swift 本体**。9（scsynth）は SC 削除で消える。11（Electron 本体）は失効 |
| §5.2 順序・`--deep` 不使用・identity `ZWULF5LA37`・ASC API キー | | **引き継ぐ** |
| §5.2 一方通行「署名 Team ID / bundle id / 配布物名」 | bundle id は VSCodium 既定（§16 (5)） | Team ID は**引き継ぐ**。🔴 **bundle id は失効**（VSCodium 既定 = `com.vscodium…` ではなくアプリ固有になる。Phase 2 で `com.signalcompose.orbitstudio` が一度使われている・§0b）→ §14 (10)。配布物名 `OrbitStudio-<version>-darwin-arm64.dmg`（§16 (5) dmg）は**引き継ぐ**（名前が変わるなら §14 (10) と一緒に） |
| §5.3 entitlements は未確認・実測手順・停止条件 | | **引き継ぐ**。候補に **node の JIT** を足す（§9.2） |
| §5.4 (a) `release.yml` の `paths` に `rust/**` `scripts/**` | | **引き継ぐ**（凍結版の CI の話。R-app では `release-app.yml` 側に同じ `paths` 方針） |
| §5.4 (b) app ジョブ「Obtain the OrbitStudio base app」が未解決 / §16 (3) 裁定 C（`.app` は手元・CI は upload だけ） | VSCodium のビルド作業場が git 管理外だったため | 🔴 **前提が変わる**: ネイティブ app は **`swift build` + `make-bundle.sh` で CI（macos-14）でも作れる**（git 管理外の作業場が無い）。したがって「手元で作って upload」は**必須ではなくなる**。ただし per-PR macOS 無しの方針（裁定 9）は生きるので、**tag 時だけ CI で作る**を推奨（§14 (6)） |
| §5.5 quarantine と受け取り側 | `.app` は Gatekeeper が起動時に検証 | **引き継ぐ**（E2E-D3 の形） |
| §6.1 #138 の受け入れ基準（`.app` を落として開いて鳴る・node が無くても） | | **引き継ぐ**（D-7 そのもの） |
| §6.2 `ORBIT_GATED_EXT_MODE=installed` | 成果物に焼かれた**拡張**を検証する | **失効**（拡張が無い）。代わりに **`ORBIT_GATED_TARGET=native` + `ORBIT_GATED_APP_PATH=<成果物>`** が同じ役割（§10.2） |
| §6.3 / §16 (8) node 同梱（裁定 B） | `extension.ts:2159` の `spawn('node')` を同梱パスへ | 🔴 改訂: **拡張側は #878 で別の解に落ちた** — `spawn(process.execPath, …, {ELECTRON_RUN_AS_NODE:'1'})`（`engine-process.ts:407-416`）で **VS Code 同梱の Node** を使い、PATH にも同梱 node にも依存しない（cold-install E2E #873 / #878 で実証）。**ネイティブ app には Electron が無い**ので、同梱 node の判断はアプリ線だけに残る（§14 (3)・**W-22 の引き継ぎ確認ではなく、アプリ線の独立した判断**として問う）。#878 の傍証: Electron 同梱 Node 24.18.1 で `@julusian/midi` の N-API prebuild が素の node と同じく読めた（`engine-process.ts:392-396`）— 同梱 node でも同じ経路（`pkg-prebuilds` が N-API で `node-napi-v7.node` に落ちる）を通る見込み。**未実測**（N0-c で確かめる） |
| §7 #498 Sentry | #656 の後・release タグ = 正本の版 + SHA | **引き継ぐ**（版の正本だけ §14 (14) に従う） |
| §8 Marketplace | | 凍結版の話 |
| §12 E2E-D1〜D5 | | D1 / D2（trust）は**失効**。D3（cold-install）/ D4（署名後の 3rd-party）/ D5（成果物の同一性）は**引き継ぐ**（D5 は `verify-app.sh`） |
| §13 `CODESIGN_PIPELINE.md` の全面改訂・`installation.md` の書き直し | | **引き継ぐ**（R-app の docs 小 PR） |
| §16 (4) trim の既定 | | **失効** |

### 9.1 成果物と同梱物

`OrbitStudio.app`（`.dmg`）= Swift 本体 + `Contents/Resources/node/`（**同梱 Node・arm64**）+ `session/`（`packages/session` dist + `node_modules`〔`@julusian/midi` の `.node` を含む〕）+ `bin/darwin-arm64/`（7 バイナリ + `std-plugins/Gain.clap`・`copy-daemon-bin.sh:120-128` と同じ集合）+ `web/`（Monaco bundle）+ **`docs/`**。

🔴 改訂: `docs/` は初版で名前だけ置いて中身を設計していなかった。**凍結版には docs の同梱が無い**（`.vscodeignore:20,28`・`mcp-server.ts:137-138` はモノレポ前提）ので、ここは「引き継ぐ」ではなく**新設**になる。何を（user サイトの Markdown + ビルド済み HTML + DSL 仕様 + manifest）、どの段で（§9.2 段 2）、どう検査するか（D-9・`verify-app.sh`）は別冊 [`848-docs-structure-design.md`](848-docs-structure-design.md) §6 が正本。

- **node 同梱**は W-22（owner 2026-09-03 Q-656-8・旧アプリ向けの裁定）を新ラインへ引き継ぐ前提で書く。**引き継ぎの確認は §14 (3)**。代替（Bun の単一実行ファイル）は N-API addon の互換が未検証なので採らない
- daemon の解決は `ORBIT_AUDIO_DAEMON_PATH`（env・`daemon-client.ts:236`）で明示。engine 側の変更なし

### 9.2 署名・公証（656 §5 を流用・SC 行を消す）

`make-local-release.sh`（app 版）の段を 656 §4.2 の 12 段に対応づける:

| 656 の段 | app 版 |
|---|---|
| 1 preflight | 同じ（git clean・SHA・**tag = app の版**・§14 (14)） |
| 2 build | `npm run build`（`packages/session` を含む）+ `copy-daemon-bin.sh` 相当（7 バイナリ + `Gain.clap`）+ `swift build -c release` + 改訂: **docs のビルドと選別**（`npm run docs:build -w @orbitscore/user-site` + 別冊 §6.3 の `build-docs-bundle.mjs` → `Contents/Resources/docs/`。**同じ commit から HTML と Markdown を作る**ので両者は乖離しない） |
| 3 package / 4 verify-vsix | **失効**（vsix は凍結版の `release.yml`） |
| 5 stage-app / 6 trim / 7 embed | **`make-bundle.sh`** に置き換え（`.app` を組み立てる。trim も embed も無い） |
| — | **`verify-app.sh`**（§9.0）。落ちたら exit 1 |
| 8 sign | 同じ（内側から・`--deep` 無し） |
| 9 notarize / 10 smoke / 11 manifest / 12 prune | 同じ（smoke は「`.app` を起動して `/mcp` が応答する」まで。音の確認は gated `native`） |

順序 **build → `make-bundle.sh` → `verify-app.sh` → 内側から署名（node・7 バイナリ・`.node`・`Gain.clap`・Swift 本体）→ `.app` 署名 → dmg → `notarytool submit --wait` → staple → `spctl --assess`**。identity `Developer ID Application: SIGNAL COMPOSE K.K. (ZWULF5LA37)`・ASC API キー（656 §5.2）。

🔴 **entitlements は推測で書かない**（656 §5.3 の実測手順をそのまま使う）。候補は 656 の 4 つに **node の JIT**（V8 は hardened runtime 下で `com.apple.security.cs.allow-jit` 相当を要するのが Electron の公知の作法。**本リポジトリでは未実測**）を足す。停止条件も 656 §5.3 と同じ（entitlements を足しても 3rd-party が読めなければ報告して止まる）。

一方通行（656 §5.2 の表がそのまま効く）: **署名 Team ID / `CFBundleIdentifier` / 配布物名**。bundle id は VSCodium 既定ではなくアプリ固有になるので **初回署名前に owner が確定**（§14 (10)）。

### 9.3 パイプライン

- `release-app.yml`（新設・tag `app-v*`・macos-14・`paths` は `apps/**` `packages/session/**` `packages/engine/**` `protocol/**` `rust/**` `scripts/**`）。**手元の `make-local-release.sh`（app 版）と同じ 1 本を呼ぶ**（656 §5.4「CI に別実装を書かない」）
- 既存 `release.yml`（`.vsix`）は凍結版のために生きる。SC ステップの削除は §12.5（凍結前・#502）
- tag 名前空間は §14 (4)。推奨は裁定 §2.7 の案どおり `ext-v*` / `app-v*`
- 自動更新（Sparkle 等）は**第 1 リリースに含めない**（§14 (5)・推奨）。GitHub Releases からの手動 DL

### 9.4 Swift の CI（§9 未検証項目への答え）

per-PR macOS ランナーは owner 方針で回さない（`rust-ci.yml:1-24`）。したがって **Swift のコンパイルは手元のマージ前ゲート**（`swift build -c release` + `make-bundle.sh` + gated `native`）で担保し、CI は tag 時の `release-app.yml` だけ（§14 (6)・推奨）。CLAUDE.md「マージ前ゲート」の 3 行に **`swift build` を無条件で足す**（条件分岐を付けない — 同節の理由と同じ）。

---

## 10. 拡張版との関係 — 「仕様書として使う」の具体

### 10.1 何が仕様か（3 層）

| 層 | 正本 | ネイティブ版での使い方 |
|---|---|---|
| **DSL の意味論** | `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` + `docs/specs-v2/` | 変わらない。実装も **`packages/engine` の 1 本**を両 host が使う（§10.3） |
| **振る舞い（実行可能な仕様）** | 凍結タグ時点の gated suite（`tests/e2e/orbitstudio-mcp-gated.spec.ts`・改訂: **7,393 行 / 49 `it`**・4.2.0）+ golden（`output-line-expectations.ts` 222 行 / `rack-chain-gain-expectations.ts` 34 行）+ 台帳（`dsl-coverage-ledger.ts`・🔴 09-18 時点で **`DSL_COVERAGE_LEDGER` は空**・`dsl-coverage-ledger.ts:27`。ラチェットの baseline 側が母集団）+ ラチェット（`dsl-e2e-coverage.spec.ts`）+ cold-install（`vsix-cold-install-gated.spec.ts`・#873） | **同じ suite を native / headless ターゲットで回す**（§10.2）。D-1 / D-2。🔴 改訂: **docs 系ツール（`get_dev_doc` / `search_dev_docs`）は gated に 1 本も無い**ので、台帳では「凍結版に E2E が無い表面」として別枠に置き、D-9 で**新規に**書く |
| **編集面の振る舞い** | 拡張の `contributes`（§7.4 の表）と `extension.ts` の各コマンド実装 | 「何をどう置き換えたか」の**パリティ台帳**（§1.2 D-1）。実装は読み替える（コピーしない） |

### 10.2 E2E をどう移すか — ハーネスをターゲット非依存にする

- `ORBIT_GATED_TARGET = vscode | native | headless`（既定 `vscode`・凍結版との互換）。差は**起動と MCP ポートの取り方だけ**:
  - `vscode`: 今日のまま（stock VS Code + `--extensionDevelopmentPath` + `ORBITSCORE_MCP_PORT`・`orbitstudio-mcp-gated.spec.ts:604-610`）
  - `native`: `OrbitStudio.app/Contents/MacOS/OrbitStudio` を `ORBITSCORE_MCP_PORT` 付きで起動（環境変数 → session の `--port --mcp`）。起動する `.app` は `ORBIT_GATED_APP_PATH`（省略時はリポジトリ内のビルド成果物。リリース成果物を指せば 656 §6.2 の「同じ E2E を成果物へ」= E2E-D3 になる）。teardown は PID オラクル
  - `headless`: `node packages/session/dist/cli.js session --port <N> --mcp`
- シナリオ本体（MCP ツール呼び出し・capture の判定）は**1 文字も変えない**。これが「両フロントエンドを同じハーネスが検証する」の実体
- `native-parity-ledger.ts`（D-1）が題名を分類し、`needs-editor` は headless で自動 skip、`not-applicable` は native で skip（理由つき）
- 🔴 **`-t` で絞れない**（suite 本体は先頭の 1 本が作った状態に依存・CLAUDE.md）は変わらない。native の小 PR でも「その PR が足した E2E だけ」が絞れない場合は全件回す

### 10.3 goldens の共有と二重メンテを避ける線引き

| 資産 | 線引き |
|---|---|
| DSL 意味論の実装（`packages/engine` の parser / interpreter / core / signal-chain / midi / timing） | **1 本**。両 host（`repl-mode.ts` = 凍結版 / `packages/session` = 新ライン）が同じモジュールを import する。新ラインの DSL 追加はここに入り、**凍結版をビルドし直せば拡張にも入る**（ただし凍結版のリリースは stable タグからで、再リリースは owner 判断） |
| host の入口 | **2 本**（`repl-mode.ts` は凍結・`packages/session` が新）。🔴 **規則: 新ラインの機能で host の協力が要るものは `packages/session` にだけ入れる。`repl-mode.ts` / `extension.ts` には触らない**（触ったら凍結違反）。DSL だけで表現できる機能は自動的に両方に入る |
| golden / fixture / capture helper | **1 本**。層 1 が同じなので数値が同じであるべき（D-2）。native で動いたら層 2 の配線を疑う |
| gated シナリオ | **1 本**。ターゲットで起動先だけ変える（§10.2）。凍結版に対する実行は **stable の保守ブランチ**（タグから切る・bug fix 時のみ）で行い、main の日常ゲートは native + headless |
| 学習サイト（user / dev） | 🔴 改訂: **「アプリを主語に書き直す」は採らない**。DSL とエンジンの章は両版に共通で、主語を書き換えると**凍結版の読者向けの記述を失う**（拡張版は将来メンテの可能性が残る・owner 要件 3）。代わりに (a) **章単位の host 分類**（editor / getting-started / 配布だけが host 依存）と (b) **機能単位の可用性表記**（`拡張版 4.2.0 / OrbitStudio 0.1.0〜` の固定文法）で両版を 1 本のサイトに保つ。正本は別冊 [`848-docs-structure-design.md`](848-docs-structure-design.md) §3〜§5。拡張の README は導線（#937 / PR #938 で済み） |

---

## 11. 棄却した案とその理由（蒸し返さないため）

| 案 | 理由 |
|---|---|
| Electron / Tauri で作る（`post-icmc/ELECTRON_APP_PLAN.md` の 3 プロセス構成・`RUST_ENGINE_MIGRATION_PLAN.md` §3 の Tauri standalone・#94 Tauri 不採用） | 裁定 2.2（Tauri も WKWebView・差分は外側）。**Monaco が WKWebView で動かない時だけ**再検討（§1.3）。Electron 計画の**機能列挙**は §7.4 に引き継いだ |
| Tracktion Engine / JUCE に載せ替える（`NATIVE_ENGINE_TRACKTION_VSCODIUM.md`） | `POST_2.0_ENGINE_AND_DISTRIBUTION.md` §0 で Rust へ（2026-06-19）。裁定 2.4 |
| VSCodium リブランド rebuild（Phase 0/1/2 まで一度成立・Serena メモリ） | 裁定 2.6。成立していた事実（bundle id・`orbs`・IDE チャネル）は §0b で拾った |
| `NSTextView` でエディタ自作 / CodeMirror | 裁定 2.2 / §10（TS を書かせるなら Monaco 一択） |
| JavaScriptCore で層 2 を in-process（§4.2 A） | UI が落ちると音が止まる・Node API の shim 22 ファイル |
| 常駐サービス + 発見（§4.2 C）を第 1 リリースで | 孤児・二重起動・発見・ソケットパス上限の問題クラスを新設する。B → C は後から足せる |
| Rust に JS エンジン埋め込み（§4.2 D）/ 層 2 の Rust 移植（E） | 裁定 §3「境界を先に固定すれば中身の言語は後で変えられる」。今払う理由が無い |
| `//#` メタ行の流用（§5.1 P-A） | 複数クライアント不可・相関ブリッジと chunk 境界の欠陥を Swift で再生産 |
| MCP を GUI プロトコルに（P-C） | サーバ → クライアントのツール呼び出しが無い・playhead の高頻度通知が無い |
| LSP 化（P-D） | Monaco に LSP クライアントが無い・評価や transport は LSP で運べない |
| stdio / Unix ソケットを RPC の transport に | 前者は親限定、後者は 103 文字上限（#830 実測） |
| Swift シェルを RPC クライアントにする（WebView は表示だけ） | 既存 TS 資産の延長線から外れ、往復が 1 段増える（§7.3） |
| `packages/engine` の即時 rename | 凍結版のビルド経路を触る（§8）。§14 (2) |
| `.xcodeproj` を正本にする | 差分がノイズ・CLI で回らない（§8） |
| Bun の単一実行ファイルで Node 同梱を避ける | N-API addon（`@julusian/midi`）の互換が未検証 |
| `/rpc` にだけ認証 token | `/mcp` が無認証で `evaluate` を開けているので意味が無い（§4.4） |
| 拡張を新 RPC の薄いクライアントに書き換える（今） | 凍結（裁定 2.5）に反する。§14 (7) で「凍結後に別 issue」として owner へ |

---

## 12. 失敗モードと観測手段（🔴 検証手段は CLAUDE.md「テストの積み上げ規律」で決め直す・本表は対象の一覧）

| # | 失敗 | 兆候 | 観測手段 |
|---|---|---|---|
| F-1 | host が死んで session / daemon が孤児に | 二重出力・デバイスが掴まれたまま | gated teardown の PID オラクル（D-1 の前提）。`orbitAudioDaemonPids()` を helper へ |
| F-2 | `file://` から `ws://127.0.0.1` へ繋がらない | skeleton で音が出ない | N0-a。代替は静的配信（§7.3） |
| F-3 | IME 変換中の ⌘Enter が評価を起こす | 未確定文字列が評価される | D-6 の owner 確認項目に明記 |
| F-4 | 逆方向リクエストのデッドロック（層 2 が editor を待ち、editor が層 2 を待つ） | `run_selection` がタイムアウト | 逆方向は**通知か短いリクエスト**に限り、editor 側は RPC を await しない設計（`editor.runSelection` は選択テキストを返すだけ・評価は層 2 が別リクエストで行う） |
| F-5 | 診断が Monaco と MCP で食い違う | `get_diagnostics` と赤線が違う | 計算が 1 箇所（§5.5）なので構造で潰す。E2E: `get_diagnostics` の件数と `editor.diagnostics` 通知の件数が一致 |
| F-6 | GUI だけの近道が入る | LLM が到達できない操作 | D-4（`x-surfaces` の検査） |
| F-7 | スキーマと生成物のずれ | Swift の decode 失敗 | `npm run protocol:check`（差分ゼロ） |
| F-8 | 署名後にファイルを削る | notarization 失敗 | 656 裁定 7（build → trim → sign の順を `make-local-release.sh` に固定） |
| F-9 | `[STEP]` 相当の通知が多すぎて WebSocket が詰まる | playhead が遅れる | N2 で 1 秒あたりの通知数を実測し、閾値を超えたら間引き（`atEpochMs` は保つ） |
| F-10 | 拡張（凍結）に新ラインの変更が漏れる | 凍結版のビルド成果物が変わる | `packages/vscode-extension/**` と `packages/engine/src/cli/repl-mode.ts` を触る PR を **CI で警告**（paths フィルタ・bug fix 以外は red にはしない） |
| F-11（改訂） | 同梱 docs が**そのリリースに無い機能**を書いている / 同梱 docs が古い | LLM が存在しない構文を勧める・ユーザーが無い設定を探す | 別冊 §5 の固定文法「未リリース」マーカーを **`verify-app.sh` で 0 件**に強制（D-9）。古さは `docs/manifest.json` の `commit` で追える。**online 取得は v1 では作らない**（別冊 §6.5） |

---

## 13. 確信度と反証方法

| 主張 | 確信度 | 反証方法 |
|---|---|---|
| §3.1 の「移す 17 本 4,290 行」は `vscode` 無しで動く | 高（`grep -L "from 'vscode'"`・09-18 再測。`import type` は `extension-state.ts` 1 本だけで、それは「消える」側） | `packages/session` へ移して `tsc` が通るか。`__dirname` 相対でリソースを探す箇所（`mcp-docs.ts:29-36`・`plugin-catalog-reader`）は起動引数へ置き換える。**通らなければ、その 1 本を「依存を剥がす」行へ移す**（表の総量は変わらない） |
| §3.1 の「消える 8 本 1,499 行」は層 2 に**不要** | 中（child-engine の stdout 経路は in-process 化で消える、という推論。`engine-lifecycle.ts` の分類規則だけは意味論として写す） | S-mcp で headless の `get_log` / `transport.state` が凍結版と同じ分類（stderr → ERROR・Playing / Ready）を返すこと。**返さなければ「規則を写し忘れた」**であって「ファイルが要る」ではない |
| 拡張 40 ファイルの vscode 依存の**行数**は 08-30（4,405）から動いていない（4,409） | 高（`wc -l` の合算） | 依存 15 本の合算を再計算。#887 が依存コードを**増やした**なら、`extension.ts` の 412 行以外に新しい `vscode.` 呼び出しが在るはず |
| `OrbitScoreToolHandlers` を層 2 の RPC で実装すれば MCP ツールの表面は不変 | 高（インタフェースが型で在る・`mcp-types.ts:176-224`） | S-mcp で gated headless の `tools/list` が凍結版と同じ 26 名を同じ順序で返す（`mcp-server.ts:91-98` の登録順コメントを含めて） |
| docs 系ツールは cold install で動かない | 高（`mcp-server.ts:137-138` の `__dirname/../../..` と `.vscodeignore:20,28`） | 凍結版の `.vsix` を cold install して `get_dev_doc` を叩く（`null` が返るはず）。**動いたら** `resolveDocsRoot` の探索先が別に在る |
| WebSocket 1 本で複数クライアントと逆方向リクエストが成立する | 高（JSON-RPC 2.0 は双方向を仕様で持つ） | N1-a で 2 クライアント同時 attach のテスト |
| Monaco が WKWebView で IME 込みで動く | 🔴 **低（未検証・裁定 §9）** | N0-a。崩れたら §1.3 の戻り |
| `file://` origin から `ws://127.0.0.1` へ繋がる | 中（未検証） | N0-a。代替あり（§7.3） |
| Node の hardened runtime に JIT の entitlement が要る | 中（Electron の公知・本リポジトリ未実測） | N0-c（656 §5.3 の手順） |
| 同梱 node で `@julusian/midi` の N-API prebuild が読める | 中（改訂: #878 が **Electron 同梱 Node 24.18.1** で読めたことを実測・`engine-process.ts:392-396`。素の同梱 node は未実測） | N0-c で `node -e "require('@julusian/midi')"` の port count が拡張版と一致 |
| 層 2 の FIFO 直列化で同時性が今日と同じになる | 高 | N1-b で人間 + LLM の交互評価を `.orbslog` の順序で確認 |
| goldens が native で動かない | 高（層 1 不変） | D-2。動いたら層 2 の配線か capture の窓 |
| Swift は数千行に収まる | 中（未実測） | N2 / N3 で `wc -l` を計画へ戻す |
| SwiftPM だけで `.app` が作れる | 高（Info.plist と bundle 構造は手で置ける） | N0-c の skeleton |

---

## 14. 🔴 owner 裁定待ち（勝手に決めていないもの）

| # | 問い | 選択肢 | 推奨と理由 |
|---|---|---|---|
| (1) | **detach**（アプリを閉じてもセッションを残す・§4.2 C）を第 1 リリースに含めるか | A 含めない（B のまま）/ B 含める（発見機構を設計） | **A**。B → C は後から足せる。孤児クラスを第 1 リリースに持ち込まない。LLM 単独は headless host で満たす（D-3） |
| (2) | `packages/engine` を rename するか（裁定 §3 のレイアウト案は `packages/session` への rename） | A しない（`session` を新設・`engine` は DSL ライブラリ）/ B rename | **A**。凍結版のビルド経路を触らない。曖昧さは `session` の新設で解ける |
| (3) | **Node 同梱**をアプリ線で採るか（改訂: W-22 の「引き継ぎ」ではない — 拡張側は #878 で VS Code 同梱の Node に乗り、この問いから外れた） | A 同梱 / B PATH の node に依存 / C Bun | **A**。D-7（cold-install で PATH の node が無くても動く）の唯一の解。B は #878 が潰した理由（Finder 起動の PATH は `/etc/paths` の最小構成）がそのままアプリにも掛かる。C は N-API 未検証 |
| (4) | タグ名前空間とワークフロー分割 | `ext-v*` / `app-v*` + `release-app.yml`（裁定 §2.7 の案） | **案どおり**。§12.7 で未決と明記されている |
| (5) | 自動更新（Sparkle 等）を第 1 リリースに含めるか | A 含めない / B 含める | **A**。署名・公証・cold-install を先に通す |
| (6) | Swift の CI | A tag 時のみ + 手元ゲート / B per-PR macOS ランナー | **A**（owner の既定方針・コスト） |
| (7) | 凍結後、拡張を新 RPC の**薄いクライアント**に書き換えるか（§3 の「クライアント 3 つ」を完成させる） | A 別 issue として保留 / B 新ラインの計画に入れる | **A**。凍結（裁定 2.5）に反するので、owner が明示する時だけ |
| (8) | エディタクライアントを同時に複数許すか | A 1 つまで / B 複数（`open_file` の宛先規則が要る） | **A** |
| (9) | `protocol/` のライセンス（裁定 §5 の事務: 素の Apache-2.0 か MIT か） | — | owner。プロトコルが公開契約になる前が最も安い |
| (10) | `.app` の bundle id・配布物名・アプリ名（「OrbitStudio」は候補名・`POST_2.0_ORBITSTUDIO_PLAN.md` owner 決定事項 8） | bundle id: A `com.signalcompose.orbitstudio`（VSCodium 版 Phase 2 で一度使われた id・Serena `orbitstudio_phase2_spike_2026-07-07`）を**そのまま使う** / B 新しい id | owner。**初回署名前に確定**（656 §5.2 一方通行）。推奨 **A**（VSCodium 版は配布されていないので衝突する既存インストールは無く、名前を増やさない） |
| (14) | **app の版の正本**（656 §4.4「拡張の `version` が正本」は app 版 = 拡張版 が崩れて**失効**・§9.0） | A `apps/OrbitStudio/VERSION` 1 ファイルを正本にし、`make-bundle.sh` が `Info.plist` へ写し、preflight で `app-v<版>` = tag を強制（656 §4.4 と同じ形）/ B `packages/session/package.json` の `version` を正本に / C ルート `package.json` | **A**。版は「ユーザーが手にする `.app`」の軸で、session や engine の内部版（`ENGINE_VERSION` / `DSL_VERSION`）とは別軸（656 §4.4 の別軸規則を引き継ぐ） |
| (11) | パリティ台帳で **not-applicable にしてよい拡張の表面**: `reloadWindow` / `openWalkthrough` / Learning view の範囲 / `startEngineDebug` の表面 | 各項目に「落とす / 置き換える」 | 推奨: `reloadWindow` 落とす（VS Code 固有）/ `openWalkthrough` 落とす（Docs パネルで代替）/ Learning view は Docs パネルに統合 / `startEngineDebug` は環境設定のトグルへ |
| (12) | #848 本文の出力先は `docs/design/847-…` だがブリーフは `848-…` | — | 本書は **848** で置いた。issue 本文の修正は main |
| (13) | 新ラインの**リリースゲート**に「ラック（#635 / #636 / #669）」を含める（裁定 §12.2「過去裁定『ラックはリリースの前提』は新ラインに対して生きる」）ことの再確認 | — | **含める**前提で地図を書いた。外すなら owner |
| (15)（改訂・別冊 §6.1） | **アプリに同梱する文書の範囲** | A user サイト（ja + en）+ DSL 仕様（`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`）/ B A + dev サイト / C user サイトのみ | **A**。LLM が要るのは「何を書けばどう鳴るか」と正本の仕様。dev サイトは 1.19 MB・引用が `path:line` でソース前提・読者が開発者なので、アプリ利用者の LLM には要らない。dev サイトは `get_dev_doc` の互換のために `--docs-dir` の追加ディレクトリとして**後から足せる**形にする |
| (16)（別冊 §5） | **可用性表記の形** | A 固定文法の 1 行（`> **対応**: 拡張版 4.2.0 以降 / OrbitStudio 0.1.0 以降`）+ frontmatter `host:` / B VitePress の custom container（`::: availability`）/ C 別ページの互換性表 | **A**。grep で検算でき（版の掃除で 4 回連続取りこぼした実績 `WORK_LOG.md` 4.2.0 節への答え）、LLM は本文中で読み、VitePress の設定を触らない。C は main の見立てどおり読まれる保証が無い |
| (17)（別冊 §4.3） | **凍結版の読者向けに 4.2.0 タグ時点の user サイトを静的スナップショットとして別パス（`/orbitscore/ext/`）で配信するか** | A 今は出さない（マーカーだけ）/ B 出す（`deploy-sites.yml` にタグ checkout のジョブ + `base` を env 化） | **A**。マーカーで足りる。B は**後から足せて戻れる**ので今決めなくてよい。凍結版の bug fix リリースが実際に出た時に再検討 |
| (18)（別冊 §7） | **docs 追従ルーチンのトリガー**と、main が 2026-09-18 に暫定追記した「新ライン = 追従対象外」「出荷済みの拡張版についてだけ書く」 | A PR マージのまま + 新ラインの PR も追従し「未リリース（OrbitStudio）」マーカー必須（暫定行は撤回）/ B owner 案 = リリース公開トリガー / C 暫定行のまま（新ラインは追従しない） | **A**。B は同梱物が構造的に 1 版古くなり、複数 PR の差分を 1 回で読むので取りこぼす（main の見立てに同意）。C は engine 線の束（O-multiout・ラック）が main に入っても文書化されず、アプリのリリース時に**まとめて書く**ことになり B と同じ取りこぼしを別の形で作る。🔴 暫定行は**前提条件つきで残す**なら「A-parity まで」と書く（memory `interim-markers-need-their-precondition`） |
| (19)（別冊 §6.5） | **リリース後の文書更新をアプリに届ける経路**を v1 に含めるか | A 含めない（1 リリース遅れを許容・manifest の `commit` で古さが分かる）/ B `--docs-dir` の上書きディレクトリ（`~/Library/Application Support/OrbitStudio/docs/`）を v1 で有効化 / C online 取得 | **A**。B は `--docs-dir` の解決順に 1 行足すだけなので設計には置くが、配る手段（zip の署名・入手経路）が無いうちは表面にしない。C は「ローカル LLM に読ませる」前提（オフライン）と噛み合わない |
| (20)（別冊 §3.4） | user サイトの**主語**（「VS Code の上で」`index.md:8` 等）と host 依存**段落**（`live-coding.md:14` / `instrument.md:37` / `effects.md:59` / `routing.md:145` ほか）を**いつ**直すか | A 段落は今（マーカー付きで両版を併記）・主語は A-parity 後 / B 全部 A-parity 後 / C 今すぐ全面 | **A**。段落は「拡張版: コマンドパレット / OrbitStudio: Catalog パネル」と併記しても DSL の記述を二重化しない。主語はアプリの表面が確定してから |

---

## 15. 裁定済み事項に対する提案（実装しない・報告のみ）

| 対象 | 提案 | 理由 |
|---|---|---|
| 裁定 §3「MIDI スケジューラと transport だけ先に Rust へ」 | 順序を「§9 の実測 → 差が聞こえたら PR-Q の `ScheduleEvents` に乗せる」に固定する | 聞こえない差に払わない（§4.6）。受け皿は既に doc 428 にある |
| 裁定 §3「`CLAUDE.md` を層ごとに配置」 | 中身は「置かないもの」だけにする（§8） | 置くものを書くと地図と二重になる |
| 裁定 §12.7 (6)「Phase 1（層 2 抽出）→ Phase 2 spike を並行」 | spike（N0）を**先に**置く。層 2 抽出は spike の結果に依存しないが、spike が崩れた時の戻り先（Electron）で層 2 の transport（WebSocket）は変わらないので並行でよい — ただし **IME の判定だけは最初に**（崩れると全体が変わる） | §1.3 |
| #757（bridge 5 本の重複） | 新ラインでは wire の request id で**消える**（§3）。凍結版では触らない | 6 本目を足す前に共通化、という #757 の着手条件は新ラインでは発生しない（09-18 も 5 本 654 行・6 本目は足されていない） |
| 裁定 §12.7 (4)「README を導線へ」/ §10.3 初版「user サイトをアプリ主語へ」 | user サイトの主語は**書き換えない**。host 依存の段落だけ併記し、機能は可用性表記で分ける（別冊） | 拡張版は将来メンテの可能性が残る（owner 要件 2026-09-18）。主語を替えると凍結版の読者向け記述を失う |

---

## 16. 改訂履歴

| 日付 | 内容 |
|---|---|
| 2026-09-11 | 初版（#848・Fable 起案・effort xhigh）。`origin/848-native-design` `1bd65b80` |
| 2026-09-18 | 改訂（Fable・effort high）。§2 を main `1276ab1f` で再測し §2b の判定表を新設。崩れた結論: §3「19 本そのまま」→ §3.1 の 3 分類表 / §9「PATH の node」→ #878 の Electron 同梱 Node（アプリ線だけに同梱の判断が残る）/ §9.1 `docs/` の中身が未設計 → 別冊 `848-docs-structure-design.md`。追加: D-9・F-11・§5.3 の 2 行・§7.4 の 1 行・§14 (15)〜(20)。用語「OrbitStudio = ネイティブ版」を固定 |
