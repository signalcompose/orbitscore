# 設計: ネイティブ macOS OrbitStudio — 層 2 のプロセス化・セッションプロトコル・Swift シェル（#848）

**対象 issue**: #848（設計・計画・地図の起案）
**関連**: [`NATIVE_MIGRATION_2026-09.md`](../planning/NATIVE_MIGRATION_2026-09.md)（移行の判断と根拠・**§12 が裁定**）/ [`IMPLEMENTATION_PLAN_NATIVE.md`](../planning/IMPLEMENTATION_PLAN_NATIVE.md)（本設計の実装順）/ [`NATIVE_DEVELOPMENT_MAP.md`](../planning/NATIVE_DEVELOPMENT_MAP.md)（新ラインの地図）
**状態**: 設計（実装しない）・初版 2026-09-11（main `229d6387` 実測・PR #831 マージ後）・改訂 2026-09-18（`1276ab1f` 再測 — 🔴 これは 09-14 の 4.2.0 マージで、09-18 の main ではない・§2）・**改訂 2026-10-23（main `7410dcb0` 再測・拡張 4.4.0 出荷後・プロトコルの形とセキュリティを確定）**・**改訂 2026-10-26（owner 裁定 第 1 回・第 2 回を反映。第 2 回の改訂は `042906b9` を起点にした）**
**起案 / 審査**: fresh subagent（起案）/ main（審査）。過去の改訂の起案者は §16。**owner の裁定は §14.0 に記録**し（第 1 回・第 2 回）、本文はそれに従う。裁定が無い事項は本文で勝手に確定させていない。
**用語（2026-09-18 owner 確定）**: 本書で **OrbitStudio** は **macOS ネイティブ版アプリ**だけを指す。VS Code 拡張は「拡張版」（**凍結線**・現 4.4.0。凍結後も owner の個別例外で 4.3.0 / 4.4.0 が出た・§0 2.5）。

> 🔴 **読み方**: §0 は再設計しない前提。§1 の**完了条件**が本書の最重要点で、§4 / §5 は「決めた後に戻れない」判断
> （層 2 のプロセス化・プロトコル）なので選択肢を尽くして推奨と理由を書いた。§14 は owner の裁定を待つもの、
> §15 は裁定済み事項への提案（実装しない）。「実測」と書いた箇所はすべて出典（ファイル:行 / 日付 / PR）を併記した。
>
> 🔴 **改訂の読み方（2026-09-18）**: 初版の §2「現在地」は 09-11 の main を根拠にしており、その後 #887 / #888 の分割・#878 の
> spawn 変更・#883 / #939 の表面変更で**数値と前提の一部が古くなった**。§2 を再測値で置き換え、**§2b に「節ごとに生き残ったか
> 崩れたか」の判定表**を置いた。崩れた結論は本文を直し、生き残った結論には根拠を足した。初版の本文は `origin/848-native-design`
> `1bd65b80` に残る。**文書（user / dev サイト）の保持構造**は本書の範囲外だったので、別冊
> [`848-docs-structure-design.md`](848-docs-structure-design.md) に新設した（§9.1・§10.3・D-9 から参照）。
>
> 🔴 **改訂の読み方（2026-10-23）**: 目的は、層 2（`packages/session`）を Linux のクラウドセッションへ出す前に
> **プロトコルの形（一方通行の判断）を確定させる**こと。クラウドは Swift / WKWebView / IME / 署名 / 実音を扱えないので、
> 曖昧さが残るとそこを推測で埋めることになる。変えたものは 5 つ:
> (1) **§2 を `7410dcb0` で再測**し、§2c に節ごとの判定を置いた（凍結後に 4.3.0 / 4.4.0 が出て、表面が動いた）。
> (2) **§5.3 を現行表面の全写像に作り直した**（MCP ツール 28・メタ行 8・stdout 4 系統・コマンド 19・HTTP 4 経路・環境変数）。
> `session.evaluate` は**状態を持たない**（`documentDirectory` 毎回必須）、`transport.step` に `source`、`log.line` に `level` / `kind`。
> (3) 🔴 **セキュリティの結論を反転した**: 旧 §4.4 / §11 の「`/rpc` にも `/mcp` にも認証を付けない（現状踏襲）」を撤回し、`/rpc` と `/mcp` の両方に
> **トークン + Origin 検証**を置く。脅威モデルは層 1〜3 をまたいで §4.7 に 1 つにまとめた。
> (4) **ライフサイクル**: F-1 に機構（stdin の EOF + 親 PID）を足し、F-12（層 2 だけが落ちる）を新設した。
> (5) **完了条件**: D-1 の基準を v4.4.0（56 `it`）へ・基準タグは 1 か所から読む / D-6 を再現手順に / D-9 を「4.2.1 の同梱を引き継ぐ」へ /
> D-10（トークン + Origin）を新設。
> 変えていないもの: 案 B・ready 行・P-B・document 同期（LSP の形）・エディタは 1 つまで・D-4・層 1 を触らない（裁定 2.4）。
>
> 🔴 **改訂の読み方（2026-10-26・owner 裁定 第 2 回）**: 裁定の原文と反映先の一覧は §14.0。本文で変えたものは 7 つ:
> (1) **パリティの再定義**（裁定 1）: 関門は「**DSL が実行された結果は拡張版と同じ**」と「人と LLM ができること（能力）が減らない」。
> MCP ツールの名前・引数・戻りは **v1 だけ**関門にした（§6.1）。評価の区切り方・画面・ログの文言は参照で、作り直してよい。
> 拡張版の通信方式から来た制約は引き継がない。拡張版の位置づけは「仕様書」から「**回帰の検算台**」へ移した（§1.2 D-1・§5.3・§10）。
> (2) **足場と「最後まで移行する」仕組み**（裁定 2 + owner の条件）: §4.5.1 を段階 1（足場 + 差分テスト）と段階 2（#997 で置き換える）に分けた。
> 最終形でないまま動くものをすべて **§1.4 の暫定物の台帳**に載せ、各行に仕組みを置いた。完了条件に **D-11** を足した。
> (3) **評価の要求に文書と範囲**（裁定 3）: `session.evaluate` に省略可能な `target` を足した（§5.3.1）。評価のかたちは #997 で決める。
> (4) **LLM の繋ぎ方 = 同梱の中継**（裁定 4）: §4.7・§6・§10.2・§12 を書き直した。人の操作なしに戻ることを完了条件 **D-12** にした。
> (5) **タイミング**（裁定 5）: §4.6 を書き直し、基準の測定を名前つきの作業 **N0-d（T-1）** にした。判断の規則も先に決めた。
> (6) **(7) 拡張版は書き直さない**（§10・§11）。
> (7) **(9) `protocol/` は Apache-2.0**（§5.8・§8）。

---

## 0. 前提 — 再設計しない裁定（`NATIVE_MIGRATION_2026-09.md` §2・§12）

| # | 裁定 | 本書での扱い |
|---|---|---|
| 2.1 | **macOS のみ**（Apple Silicon・`PROJECT_RULES.md`「Platform Support」） | `cfg` 抽象・Windows 用の温存はしない |
| 2.2 | **Swift / AppKit で新規開発**。Swift の面積はシェルだけ。`NSTextView` でエディタを自作しない | §7 |
| 2.3 | **エディタは Monaco**（§9 の「WKWebView で動くか」に依存） | §7・ステージ N0 の spike |
| 2.4 | **Rust オーディオエンジンは書き換えない**。JUCE を使わない | 層 1 は本書の対象外。daemon protocol は**本書では触らない**。🔴 改訂: 初版が引いた「v0.2」は 09-18 時点で **`PROTOCOL_VERSION = "0.3"`**（`rust/crates/orbit-audio-daemon/src/protocol.rs:8`）— 層 1 の wire は **engine 線（O-wire-b 等）で進む**ので「不変」ではなく「**アプリ線が触らない**」と読む |
| 2.5 | **VS Code 拡張は残すが機能凍結**（Marketplace / Open VSX が発見経路） | §10。凍結線は初版の「O-surface 完了」から #883 で **4.0.0** へ動き（`DEVELOPMENT_MAP.md:236-241`）、4.1.0（pan 減衰・#921）/ 4.2.0（#939 / #940・PR #943・2026-09-14）を経て凍結された（owner 2026-09-18）。🔴 改訂（2026-10-23）: **凍結は「以後 bug fix だけ」ではなかった**。owner の個別例外で **4.3.0**（Pitch DSL の乱数 `r` / `rr` / `random.<mode>`・#967 / #973・`NATIVE_MIGRATION_2026-09.md` §12.8）と **4.4.0**（`evaluate_orbitscore` の `document_path`・`//#documentDirectory` の空値 = クリア・VST3 の state を `.vstpreset` で保存・#984〜#986 / #989・PR #993・`7410dcb0`）が出た。#987（`[STEP]` の出どころ）が 3 件目の例外として提案中。したがって本書は「凍結 = 表面が止まる」を前提にせず、**列挙と台帳の基準タグを 1 か所から読む**（§1.2 D-1・§5.7） |
| 2.6 | **VSCodium フォークを畳む** | ✅ gated ハーネスは stock VS Code 起動へ切替済み（PR #831・2026-09-10・`WORK_LOG.md`「test(e2e): launch the gated harness from stock VS Code」） |
| 2.7 | **モノレポ維持**。リリースはパイプラインを分ける（`ext-v*` / `app-v*` は**未決**・§12.7） | §8・§9 |
| 2.8 | **claude-code 拡張は同梱しない**。LLM とは MCP で通信 | §6 |
| §12.2 | 凍結線 = **O-surface（PR-O4）完了** → #883 で **4.0.0** へ移動 → **4.2.0 で凍結**（上の 2.5）→ 改訂: 例外で 4.3.0 / 4.4.0 | 新ラインは凍結の翌日から始めてよい（§12.1）— **その日は来ている**。O-surface の成果物（`//#evalBegin` / `//#evalEnd`・`packages/engine/src/cli/repl-mode.ts:108-115`）は凍結版に入っている |
| §12.3 | **O-multiout が新ラインの最初の束**。ステージ 3〜7 は層 1 / 2 の作業なのでそのまま生きる。ステージ 8（配布）は再定義 | 計画 §2 で束として位置づける。本書は**再定義する配布**だけを設計する（§9） |
| §12 補正 | `runSelection` の subject-block 解決（改訂: #887 で `packages/vscode-extension/src/run-selection.ts:27` `getLineSubject` へ移動）は DSL 意味論に近いので層 2 へ / **同時性**は消えない / walking skeleton の完了条件に **IME** を含める | §5.6・§5.7・§1.3 |
| 地図 §1 | GUI の操作結果は必ず DSL テキストに落ちる（#681）/ LLM は DSL 経由で使う / 投資順位は 1 仕様 → 2 E2E → 3 機能テスト → 4 変異 | §7.2・§1.2 |

**本書が新しく決めるもの**（§2 に無い = 起案の対象）: 層 2 の**プロセス形態と所有権**（§4）/ **セッションプロトコル**（§5）/ MCP の置き場（§6）/ GUI とセッションの責務分割（§7）/ ディレクトリレイアウト（§8）/ 配布の**差分**（§9）/ 拡張版を**回帰の検算台**として使う具体（§10。改訂 10-26: 旧「仕様書として使う」を裁定 1 で改めた）/ 暫定物の台帳（§1.4・10-26 追加）。

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
| `EDITOR_HOST_AND_APP_SIZE.md`（2026-08-30） | 拡張 9,131 行のうち **vscode 非依存 4,726 / 依存 4,405**。依存の中身はダイアログ・パレット・設定・TreeView・ステータスバー・診断表示であって**テキスト編集は 1 つも無い** | **引き継ぐ**。🔴 改訂: 09-14（`1276ab1f`）の再測は **41 ファイル 10,471 行のうち vscode 依存 15 ファイル 4,409 行 / 非依存 26 ファイル 6,062 行**（旧版の「40 ファイル」は数え違い）、10-23（`7410dcb0`）は **43 ファイル 10,810 行・依存 15 ファイル 4,452 行 / 非依存 28 ファイル 6,358 行**（§2）。**依存の行数は 08-30 の 4,405 → 4,452 でほぼ動いていない** — #887 の分割で依存コードが `extension.ts` から 14 ファイルへ**配られた**だけで、依存の総量は増えていない。「書き直す約 4,400 行 = 編集面の配線」は**そのまま §7.4 パリティ表の母集団** | §2・§2b・§7.4 |
| 同 §7.1「**自作しない**。VSIX + 軽量化 VSCodium 同梱」 | | **失効**（裁定 2.2 が 2026-09-10 に覆した）。ただし同書が挙げた対価「**VS Code が無料で提供しているもの**（設定 UI・キーバインド・複数ファイル・検索・undo/redo・ハイライト）を自前にする」は**そのまま本書の払う費用**であり、§7.1 の `NSDocument` / Monaco 標準機能（検索・undo）はそれへの答え | §7.1・§7.4 |
| 同 §3-5 ソースマップ 334 MB・trim → 署名の順序 | | trim 自体は**失効**（Electron が無い）。「**署名済みバンドルを後から触ると署名が壊れる**」原則は**引き継ぐ**（`make-bundle.sh` の順序） | §9.2 |
| 同 §7.2「`.vsix` が機能の 100%・app 版 = 拡張版」 | | **失効**。ネイティブ app は拡張と別物なので **app 版 = 拡張版 が定義として成立しない** → バージョンの正本を決め直す（§14 (14)） | §9・§14 |
| `656-release-design.md`（2026-09-03） | 署名・公証・cold-install・ローカルリリース・Marketplace | **§0 の裁定 10 件と §16 の回答 8 件を 1 行ずつ引き継ぐ / 失効に仕分けする**（§9.0 の表）。再設計しない | §9 |
| `USER_OUTCOMES_2026-09.md` | 各 PR / ステージが終わるとユーザーは何ができるか（🎵 / 👀 / 🧱 / 📄） | **引き継ぐ**（粒度の手本）。地図 §3.3 に同じ形の表を置く | 地図 §3.3 |
| `post-icmc/ELECTRON_APP_PLAN.md`（Electron + Monaco） | Electron 3 プロセス構成・Monaco 統合・IPC・機能列挙・electron-builder・自動更新・拡張性 3 案 | Electron は**棄却**（裁定 2.2・Tauri 不採用 #94 も同じ系）。**機能列挙は引き継ぐ**: File メニュー（New / Open / Save / Save As）・検索置換（Monaco 標準）・ステータスバー（engine 状態 / **BPM** / カーソル位置）・設定パネル・Monaco の**カスタムビルドで約 1 MB**（不要言語の worker を外す）。拡張性 3 案は **DSL Plugin（#671 / #672）**に置き換わった | §7.4・§11 |
| `post-icmc/AUDIO_ENGINE_CORE_ARCHITECTURE.md`（2026-04-17） | Core は DSL / musical time / UI を**知らない**。「橋渡しは層ではなくプロトコル（JSON-RPC on WebSocket）」。musical timing は **TS に残し、複数フロントが同じ timing を使う必要が出た時に Rust へ** | **引き継ぐ**。層 2 ↔ 層 3 も「プロトコルで橋渡し」（§5）。🔴 **Rust 化の判断基準は本書の形では満たされない** — フロントは 3 つになるが、timing を持つ層 2 は **1 プロセス**で全フロントを受けるため。したがって MIDI / transport の Rust 化は「複数フロント」ではなく **§9 の実測（聞こえるか）**だけを引き金にする。改訂（10-26）: 実測は名前つきの作業 **N0-d（T-1）**にし、判断の規則を先に決めた | §4.6 |
| `post-icmc/RUST_ENGINE_MIGRATION_PLAN.md`（2026-04-17） | **Engine-as-a-Service**: エンジンをデーモン化し複数フロント（VS Code / standalone / Web / CLI / LLM）。VS Code 拡張は「LSP 的にエンジンと通信する薄い TS」 | **引き継ぐ**（本書の「クライアント 3 つ・背骨 1 つ」はこの図そのもの。背骨が層 1 + 層 2 の 2 段になった点だけが違う）。Tauri / CodeMirror / Phase 3「Tauri standalone」は**失効**（裁定 2.2・2.3）。「拡張を薄いクライアントに」は改訂（10-26）: **採らない**（§14.0 (7)・拡張版は凍結のまま退役まで保つ。他のエディタから繋ぐ日は、公開したプロトコルに繋ぐ一般の窓口として作る） | §4・§14 (7) |
| `DAW_AUDIO_ARCHITECTURE.md`（2026-06-21） | 標準 DAW の信号経路・**graph は engine core が所有しプラグインは順序を知らない**・PDC・tap 点 | **引き継ぐ**。層 3 の責務境界の参照: DAW の UI は graph を描き替えを**依頼**するだけで所有しない → 本書の「GUI は DSL テキストの編集面」（§7.2）はその写し。PDC / sidechain は層 1（engine 線 K / O-multiout） | §3・§7.2 |
| `2026-09-03-issue-triage.md` | クラスタ C5 配布（#656 / #197 / #184 / #385 / #659 / #321）・#94 Tauri 不採用（CLOSED）・#379 → #656 | **引き継ぐ**（ネイティブ線へ持ち越す配布 issue の母集団 = C5）。#385 は凍結版の話。#321（LinkAudio の GPL）は engine 線 P 束の話で本書は触らない | 地図 §4.D |
| Serena `post_2.0_native_engine_roadmap` | 戦略レイヤ（engine-first・permissive・freemium・**OrbitScore = 言語 / OrbitStudio = 候補名**） | 引き継ぐ（名前は候補のまま・§14 (10)） | §14 |
| Serena `orbitstudio_phase0_phase1_2026-07-07` / `orbitstudio_phase2_spike_2026-07-07` | **OrbitStudio（VSCodium）の Phase 0 / 1 / 2 は一度やりかけて成立していた**: side-load（gate A/B PASS）・B1 リブランド build（`CFBundleIdentifier=com.signalcompose.orbitstudio`・CLI 名 `orbs`）・Claude Code の IDE チャネル probe・#384 / #385 の発見 | **失効**（フォークは畳む）。ただし 3 点は**引き継ぐ**: (a) bundle id の候補 `com.signalcompose.orbitstudio` は**既に一度使われた id**なので、ネイティブ app で同じ id を使うか別にするかは §14 (10) の材料 (b) **#385 型の沈黙**（activate しない・何も起きない）は D-5「黙らない」の根拠 (c) **subagent の detached build は完了通知が飛ばない**運用知見は計画 §5 の委譲に効く | §9・§14 (10) |
| `post-icmc/COLLABORATION_FEATURE_PLAN.md`（P2P 協調・2,750 行） | WebRTC P2P + シグナリング・ホストマイグレーション・各自の engine で鳴らす・音の排他 3 モード | **範囲外**。ただし**後から入れられる形か**だけ確認した: 協調は「document の同期 + 評価要求の中継」であり、本書では層 3 のクライアント（または session 間のブリッジ）として乗る。層 2 が document の写し（§5.5）と FIFO の評価キュー（§5.6）と出自（`clientId`）を既に持つので、**層 2 の中を変えずに**足せる。🔴 同計画の「ホストマイグレーションの確認ダイアログ」は D-5（確認を挟まない）と衝突するので、着手時に設計し直す | §5.5・§5.6 |

---

## 1. 到達点と 🔴 完了条件

### 1.1 到達点（1 文）

**新しい Mac で `OrbitStudio.app` を開き、`.orbs` を書いて ⌘Enter で音が出て playhead が動き、同じセッションに LLM が MCP で入って同じ譜面を評価できる。DSL が実行された結果は拡張版と同じで（同じ golden）、人と LLM ができることは拡張版より減らない。それを凍結版と同じ gated E2E が確かめる（v1 では同じツール名で）。**

改訂（10-26・裁定 1）: 旧版の到達点は「凍結版の拡張と同じ gated E2E（同じツール名・同じ golden）で緑」で、拡張版の**形**まで関門にしていた。owner の裁定で関門を 2 つに絞った。

- **DSL が実行された結果は拡張版と同じ**（音・診断・状態。キャプチャ WAV の判定を含む実機テスト）
- **能力が減らない**

MCP ツールの名前・引数・戻りは **v1 だけ**関門で、v1 の後はアプリに合わせて変えてよい（§6.1）。owner の意見（原文）: 「うん、DSLが実行された結果はVSIXと同じにならないといけないね。」

### 1.2 完了条件（何が緑なら done か・何を検証すれば正しいと言えるか）

「ネイティブ版が拡張版に追いついた」を**自己申告で言わない**ための定義。各行は**仕組み**（テスト・スクリプト）に落とし、CLAUDE.md「規律を足す時は仕組みを足す」に従う。

| # | 条件 | 検証手段（仕組み） | 何が保証されるか |
|---|---|---|---|
| **D-1 パリティ** | 凍結版 gated suite の `it` 題名のうち **native 必須**に分類された全件が、`ORBIT_GATED_TARGET=native`（`OrbitStudio.app` を起動して MCP で駆動）で緑。🔴 改訂（10-26・裁定 1）: **分類の規則** — 題名が確かめているのが **DSL が実行された結果**（音・診断・状態）か、人か LLM の**能力**なら `native-required`。**拡張版の形**だけを確かめている題名（VS Code の UI・`.vsix` の中身の配置・stdio の `//#` メタ行の文法・拡張版の通信方式から来た制約）は `not-applicable(理由)`。観測の手段だけが拡張版の形に依存する題名は、題名を `native-required` のまま残し、観測の手段をハーネスの側で差し替える（シナリオ本体は MCP 経由なので通常は要らない）。v4.4.0 の 56 題名をこの規則で予備的に読むと、拡張版の形**だけ**を確かめる題名は見当たらない（全件が MCP 経由で DSL の結果か能力を確かめている。予備判定・確信度中。題名ごとの分類と根拠は N1-b4 で台帳に書く） | `tests/e2e/native-parity-ledger.ts`（新設）: **基準タグ**時点の gated `it` 題名を全列挙し、各題名を `native-required` / `not-applicable(理由)` のどちらかに分類する台帳。**未分類が 1 件でもあれば red**（`dsl-e2e-coverage.spec.ts` と同じラチェット形）。🔴 改訂（10-23）: **基準タグは 1 か所から読む** — 台帳ファイルの定数 `PARITY_BASELINE_TAG`（現在 **`v4.4.0`** = `7410dcb0`）を正本にし、台帳の母集団・§5.3 の列挙（§5.7）・本書の件数はそこから読む。凍結版に owner の個別例外が入ってタグが進んだら、**その PR で定数を進め、増えた題名を分類する**（未分類 red が分類を強制する）。母集団は **v4.4.0 の 56 `it`**（`tests/e2e/orbitstudio-mcp-gated.spec.ts` 7,855 行・`grep -cE "^ +(it\|test)(\.[a-zA-Z]+)?\("`・`it.skipIf` を含む字面の数）。4.2.0 の 49 からの +7 は `#964` 1 / `#966` 2 / `#967` の乱数 4（うち 1 本は `#974` の和音変数）。**v4.4.0 の実機の passed 数は未測**。旧版の根拠「2026-09-14 実機 48 passed・`WORK_LOG.md:452`」は、#947 で WORK_LOG の 20 エントリが archive へ移り `WORK_LOG.md:452` が別の内容を指すようになったので、根拠ごと外した | 「拡張でできたことがアプリでできる」を**題名単位で機械が数える**。`not-applicable` は owner 裁定（§14 (11)）と、改訂（10-26）の分類の規則（理由の列が空なら red） |
| **D-2 音の同一性**（= **DSL が実行された結果は拡張版と同じ**・裁定 1 の関門） | 既存 golden（`tests/e2e/output-line-expectations.ts` の `OUTPUT_LINE_GOLDENS`・`rack-chain-gain-expectations.ts`）が native / headless ターゲットで **1 つも動かない**。改訂（10-26）: 評価のかたちを #997 で変える PR（段階 2・§4.5.1）でも **golden は動かない**のが前提である。golden は正しい DSL の音を固定しており、#997 が変えるのは誤りを含む入力や区切りの判定（凍結版の「バグ的な振る舞い」・#965 / #620 / #695 ほか）の側だからで、その差は差分テストの「違いの記録」に 1 件ずつ載る（§4.5.1）。🔴 段階 2 で golden が動いたら、それは関門（拡張版と同じ結果）に触れる変更なので、期待値を書き換える前に **owner に確かめる** | 同じ fixture・同じ capture 窓を同じ helper（`tests/e2e/helpers/capture-windows.ts`）で測る。層 1 は不変（裁定 2.4）なので、動いたら**層 2 の配線か capture の窓が壊れた**ことになる | 束 O-wire と同じ検算（`BUNDLE_BRANCH_WORKFLOW.md` §5.1）。**振る舞いを変えない移行を「動かないこと」で検証する機会**を、アプリの機能追加と混ぜずに使い切る |
| **D-3 LLM 単独** | エディタを 1 つも開かずに `orbitscore session`（改訂 10-26: TCP を開かない既定のまま）を起動し、**中継**（§6）を stdio で起動して、`ORBIT_GATED_TARGET=headless` で **editor 非依存**の題名が全件緑 | 台帳の `needs-editor` 列で自動 skip。headless で `open_file` 等を呼ぶと構造化エラー `NO_EDITOR_ATTACHED` が返ること自体を 1 本のテストで固定 | 「LLM は第一級ユーザー」（memory `orbitstudio-shared-medium-human-llm`）を GUI 無しで満たす。§3 の「エディタを閉じてもエージェントが動く」の**第 1 リリースでの形** |
| **D-4 特権経路ゼロ** | アプリの GUI が呼ぶ RPC メソッド集合 ⊆ MCP ツールが呼ぶ RPC メソッド集合 | `protocol/` のスキーマで各メソッドに `surfaces: ["gui","mcp"]` を宣言し、`tests/protocol/surface-coverage.spec.ts`（新設）が **`gui` を持つメソッドで `mcp` を持たないものが 1 つでもあれば red** | 「UI に特権的な経路を作らない」（`NATIVE_MIGRATION` §3）を宣言でなく検査で保つ。GUI で出来て LLM で出来ないことが**構造的に作れない** |
| **D-5 確認・停止を挟まない** | 評価経路（`session.evaluate` に至る全 GUI 操作）に**モーダル・確認ダイアログ・自動ウィンドウ開閉が無い** | Swift 側に「評価経路で `NSAlert` を出す API を持たない」（§7.3 の構造）+ gated `native` で `run_selection` を 50 回連続して所要時間の分散が閾値内（モーダルが出ると人待ちで秒単位に跳ねる。閾値は N2 で実測して決める） | memory `live-coding-forbids-workflow-interruptions` / `ui-windows-only-open-and-close-by-user` |
| **D-6 IME** | WKWebView 上の Monaco で、日本語入力の**次の再現手順が 1 つも再現しない**（改訂 10-23: 「IME が動く」を手順に置き換えた）: ① monaco-editor **#4796**（中国語・日本語の変換中に行が上下に跳ねる。WebKit の textarea 経路で再現・修正 PR microsoft/vscode#333909 は 2026-10-23 時点で未マージ）② **#5390**（逆向きの選択範囲の上で最初の 1 打鍵が落ちる）③ **#3549**（`wordWrap` 有効時の日本語 IME）④ **変換中の ⌘Enter** が評価を起こさない（F-3）⑤ **変換中に blur** しても未確定文字列が失われず、エディタの状態が壊れない（WebKit Bugzilla 164369: Safari は blur 時に `compositionend` を出さない） | 🔴 **自動化できない**（IME はアクセシビリティ API から駆動しにくい）。**owner の実機確認**を N0 / N2 の受け入れに置き、①〜⑤ の結果・確認した日付・ビルド hash・**Monaco の版**を `WORK_LOG` に残す。🔴 **Monaco の版の固定とパッチの当て方を N0-a で決める**（上流の修正が入らない場合の備え。版の固定の仕方とパッチの置き場は N0-a の結論として計画に戻す） | 裁定 §12.7 (6)「Phase 2 spike（Monaco + IME）」。🔴 **拡張版で IME が動いた実績は予測にならない**: Monaco の `editContext` は既定 true だが、効くのは `env.editContextSupported` の時だけで（microsoft/vscode `src/vs/editor/common/config/editorOptions.ts:2081-2088,6330-6333`）、**WKWebView には EditContext が無い**（WebKit standards-positions #243 が OPEN）ので textarea 経路（`TextAreaEditContext`）を通る。VS Code 本体の日常利用は EditContext 側なので、textarea 側の退行は上流で見つかりにくい（調査 2026-10-23・`gh api` で issue / PR の状態を確認） |
| **D-7 cold-install** | 何も入っていない macOS アカウントで `.dmg` → 起動 → 初めて開くフォルダの `.orbs` を評価して音が出る。**PATH の `node` が無くても**起動する | `656-release-design.md` §6 の E2E-D3 の形（PATH を絞って走らせる）を native 成果物へ向ける。署名は `spctl --assess`。改訂: 凍結版には同型のテストが**既に在る**（`npm run test:e2e:cold-install`・`tests/e2e/vsix-cold-install-gated.spec.ts`・#873 / #878）。その `.app` 版を書く | 配布の再定義（§9）。W-22（node 同梱）の帰結。改訂: 拡張版は #878 で **VS Code 同梱の Node**（`process.execPath` + `ELECTRON_RUN_AS_NODE`・`engine-process.ts:407-416`）を使うようになり PATH 非依存になったが、**ネイティブ app には Electron が無い**ので node 同梱の必要はアプリ線だけに残る |
| **D-8 文書** | 地図 §「現在地」が事実と一致（閉じた issue を未着手と書かない） | `tests/docs/planning-issue-state.spec.ts` の `DOCUMENTS` に `NATIVE_DEVELOPMENT_MAP.md` / `IMPLEMENTATION_PLAN_NATIVE.md` を足す（🔴 本 PR は `tests/` を触らないので **main の follow-up**。改訂: 09-18 時点でも `DOCUMENTS` は旧地図と旧計画の 2 本だけ・`planning-issue-state.spec.ts:41-44`・**未対応のまま**） | #814 と同じ仕組み |
| **D-9 文書同梱**（09-18 追加・10-23 改訂・owner 要件 2026-09-18） | `.app` 単体（ネットワーク無し・リポジトリ無し）で **Docs パネルと `docs.get` / `docs.search`（`site:"user"`）が同梱文書を返す**。`site:"dev"` は凍結版と同じ「同梱しない」契約の応答を返す（§5.3）。同梱文書に「未リリース」マーカーが **0 件** | `verify-app.sh` が `Contents/Resources/docs/manifest.json` と `index.html` の実在を検査 + cold-install E2E（D-7）で `get_user_doc` を 1 回・`get_dev_doc` を 1 回叩く（凍結版の `assertDocsBundled`・`tests/e2e/vsix-cold-install-gated.spec.ts:155-175` の `.app` 版）+ `未リリース` マーカーの grep が 0 件（別冊 §6.4） | 🔴 改訂（10-23）: 根拠を「新しい表面」から**「拡張 4.2.1（#954 / PR #955・2026-09-18）で `.vsix` に入った user サイトの同梱を `.app` に引き継ぐ」**へ改めた。凍結版は `scripts/copy-user-site.sh` で user サイト（Markdown 45 本 + ビルド済み dist）を**拡張パッケージの内側** `packages/vscode-extension/sites/user/` へコピーし（`.vscodeignore` の `../../**` 除外には当たらない）、`resolveUserDocsLocation`（モノレポ → `extension-bundle`・`mcp-server.ts:151-154`）で読む。**dev サイトは owner 決定（2026-09-18）で意図的に同梱しない**（`mcp-docs.ts:38-48` の `DEV_DOCS_UNAVAILABLE_MESSAGE`）。旧版の「凍結版は docs を同梱していない」は、旧版の日付当日（09-18 09:37 の #955 マージ）に既に偽だった。アプリで新しいのは**同梱の形**（別冊 §6.2: Markdown + dist + DSL 仕様 + manifest）と `.app` での検査だけ |
| **D-10 接続の認証**（10-23 追加・🔴 10-26 に書き直し・裁定 4） | (1) **TCP の `/rpc`** が **Host 許可外・Origin 許可外・`Origin: null`・Origin なし・トークンなし・トークン違い** の 6 通りを拒否し（upgrade で 403 か attach で close 1008）、**許可された Origin + 正しいトークン**（WebView）は通す (2) **TCP に `/mcp` が無い**（`POST /mcp` → 404）(3) runtime-dir が **0700 で自分の所有**でなければ session が起動しない（`{"ready":false,…}`）・ソケットは **0600** (4) **UDS の `/rpc`** はトークンなしで attach できる (5) TCP のトークンの文字列が ready 行以外の出力（log ring = `get_log`・session の stderr・アプリのログ）に **1 回も現れない** (6) **中継が §6.2 の RL-1〜RL-5 を守る**（上流が落ちても終了しない・上流なしで `tools/list` と `server/discover` に即答・届かなければ `isError`・送った後に切れた評価を再送しない・MAJOR 違いは `isError` で案内）。旧 10-23 の (e)「Origin なし + 正しいトークン → 通す」は、非ブラウザのクライアントが UDS へ移ったので**拒否に変わった** | unit（`packages/session`・**Linux で完結**・HTTP と WebSocket を実際に開く）: (1) の 6 + 1 = 7 ケース・(2)・(3)（0755 のディレクトリで起動 → `ready:false`・ソケットの mode を `stat`）・(4)・(6)（§6.2 の検査列: 層 2 を `kill -9` して中継の PID が同じ・層 2 なしで 28 本と `isError`・`session.evaluate` の到着が高々 1 回・版を偽った層 2・`server/discover` の応答時間）+ gated `native` で「TCP の `/rpc` にトークンなし → 拒否」を 1 本（ほかの gated は全部中継 = UDS を通るので (4) は全件で使われる）+ 各 gated `native` 実行の終わりにトークン文字列を `get_log` の全行と session の stderr へ grep して 0 件。🔴 **別のユーザーからの `connect` が拒否されること**（T-2）は CI で別の uid を作れないので、N2 で 1 回だけ手で確かめて `WORK_LOG` に残す（再検討 5.5） | §4.7 の規則を宣言でなく検査で保つ。D-1〜D-9 のどれにも含めず独立させたのは、**拒否されること**は機能のパリティ（D-1）では観測できないため |
| **D-11 暫定物が残っていない**（10-26 追加・裁定 2 の owner の条件） | §1.4 の暫定物の台帳のうち、期限が `release-1`（第 1 リリース）の行が**全部閉じている**。コードに `PROVISIONAL(P-xx)` の印が 1 つも残っていない（期限が `ext-retire` の行は除く） | `tests/repo/native-provisional-ledger.spec.ts`（新設・§1.4.2）を **`ORBIT_RELEASE_PREFLIGHT=1`** で走らせる。`verify-app.sh` がリリースの時にこれを呼ぶので、足場が残っていると `release-app.yml` と手元の `make-local-release.sh` の両方が落ちる | owner の条件「段階を分けて移行する場合には、ちゃんと忘れずに最後まで移行をするように」を、文章の注意ではなく**リリースが通らない形**で守る。D-1〜D-10 は「できること」を数え、D-11 は「**最終形でないまま動いているもの**」を数える（動いていれば D-1 は緑になるので、D-1 では足場の残りを観測できない） |
| **D-12 LLM が締め出されない**（10-26 追加・裁定 4・owner の懸念「ライブ中に使えなくなるとかがあると困る」） | §4.7.1 の表のうち、owner が挙げた 5 つの場面 — **演奏中（E1）・F-12（E2）・アプリの立ち上げ直し（E3）・スリープからの復帰（E4）・Claude Code の再起動（E5）** — と E6・E7・E11〜E13 で、**LLM クライアントの側の人の操作（再登録・再接続）なしに**次のツール呼び出しが通る。登録は 1 回で、アプリの再起動・ポート・トークンの変化で書き直さない。例外は **E8**（MAJOR を変える更新の後に 1 回）と **E10**（中継の異常終了）の 2 つだけで、どちらも `isError` の文言か Claude Code の表示で**黙らずに**分かる | unit（**Linux で完結**・D-10 の (6) と同じ §6.2 の検査列 + RL-7 の止め方）+ gated `native` で 2 本: (a) アプリを終了して起動し直し、**同じ中継のプロセス**で次の呼び出しが通る（E3）(b) session を `kill` し、アプリが自動で起動し直した後（§12 F-12）、同じ中継で次の呼び出しが通る（E2）。E4（スリープ）は自動化できないので N2 で 1 回手で確かめて `WORK_LOG` に残す | 登録の仕組み（HTTP + 起動ごとの値）では、Claude Code の再接続の上限（途中切断は約 31 秒・初回 3 回・stdio の終了は手動）に縛られて E1〜E3・E6 が手動になる（§4.7.1）。「締め出されない」を Claude Code の振る舞いではなく**私たちが出荷するコード**で保証したことを、拒否の検査（D-10）とは別に数える |

**done の判定は D-1〜D-12 の全部**（改訂 10-26: D-11・D-12 を足した）。D-6 だけが人手で、それ以外は機械（改訂 10-26: D-10 の T-2〔別のユーザー〕と D-12 の E4〔スリープ〕は N2 で 1 回だけ手で確かめる）。**「ユニット緑」は D-10・D-12 の一部を除きどの条件にも現れない**（CLAUDE.md「ユニットは部品しか見ない」。D-10 の拒否の検査は HTTP / WebSocket / UDS を実際に開き、D-12 の RL の検査は中継と層 2 のプロセスを実際に落として起こし直すので、部品の検査ではない）。

### 1.3 walking skeleton（ステージ N2）の完了条件

裁定 §5 Phase 2 の文をそのまま受け、IME を足す:

1. ウィンドウが開き、WKWebView に Monaco が載って `.orbs` がハイライトされる
2. 層 2（`packages/session`）に繋がり、選択範囲評価で**音が出る**（capture WAV の RMS > 0・`ORBIT_GATED_TARGET=native` の 1 本目）
3. playhead が動く（`transport.step` イベントが WebView に届き decoration が出る）。改訂（10-23）: WebView の playhead は **`transport.step` の `source`（§5.3）を正本として書く**。`source` が `null` の間だけ、既存 `playhead.ts` の pure 関数（文字列照合）を**暫定の消費者**として使う。🔴 **暫定の条件**: `source` を埋める engine 側の仕事（パーサの位置の木・予約時の出どころ・#987 B′ の §6）が main に入るまで。入ったら WebView から `playhead.ts` を外す（新しい文字列検索は書かない — 外すのは移した 1 ファイルだけ）。改訂（10-26）: この暫定は台帳の **P-04**（§1.4）で、期限は第 1 リリース。印が残っているとリリースが落ちる
4. **日本語 IME が動く**（D-6 の再現手順 ①〜⑤）
5. タブ・保存・設定は**無い**（あると skeleton の判定が遅れる）

🔴 **ここが崩れたら Electron 検討へ戻る**（裁定 §9「最大の未知数」）。崩れたかどうかの判定は 1〜4 の実機結果で、推測で先送りしない。

### 1.4 🔴 暫定物の台帳（2026-10-26 新設・裁定 2 の owner の条件）

> 「ただし段階を分けて移行する場合には、ちゃんと忘れずに最後まで移行をするように。こういうのって動いて安心して終わってしまうことがあるので。そういう視点で再考してみて。」（owner・裁定シート第 2 回・項目 2）

**暫定物** = 最終形でないまま**動く**もの。段階移行の足場、「v1 だけ」の関門、「後で」「申し送り」とした仕事、暫定の消費者、暫定行、置き値の閾値がこれに当たる。暫定物が危ないのは、**動いているので D-1〜D-10 が緑になる**ことである。緑のまま最終形へ移る理由が失われ、その形で出荷される。

規則は CLAUDE.md「規律を足す時は、同時にそれを守らせる仕組みを足すこと」に従う。台帳の各行は**強制する仕組み**を 1 つ持つ（テスト・ラチェット・リリースの preflight・🚪 の条件・`release-gate` の issue のどれか）。仕組みを置けない行は、置けない理由を書く。**新しい暫定物を作る PR は、同じ PR で台帳に行を足す**（§1.4.2 の検査 1 が強制する）。

#### 1.4.1 台帳

「期限」の種類: **`release-1`** = 第 1 リリース（🚪）までに閉じる。`verify-app.sh` が落とす / **`when-exists:<path>`** = そのパスがリポジトリに現れた時点で閉じていなければ red / **`ext-retire`** = 拡張版の退役（`packages/vscode-extension/` が消える PR）で閉じる / **`external`** = 外部の上流に依存し、機械では期限を切れない（理由を書く）。

| # | 何が暫定か | 最終形 | 完了条件 | 🔴 強制する仕組み | 期限 | 担当の束（入る → 消える） |
|---|---|---|---|---|---|---|
| **P-01** | **評価の受付口の足場**（§4.5.1 段階 1）。凍結版の区切り方の写しを `packages/session/src/eval/` に置き、結果を構造化した値で返す。`session.evaluate` の `target`（§5.3.1）は受け取るが、区切りには使わない | **#997 の評価のかたち**（段階 2）。層 2 が同期済みの文書と `target` から区切りを決める | #997 の実装 PR がマージされ、足場のモジュールが消え、P-02 の差分テストが「違いの記録」に書き換わっている | 足場のファイルに `PROVISIONAL(P-01)`。**リリースの preflight**（`verify-app.sh` → 台帳の spec を `ORBIT_RELEASE_PREFLIGHT=1` で）が、印か開いた行が残っていれば落ちる = **D-11** | `release-1` | S-rpc（N1-a0）→ **S-eval** |
| **P-02** | **凍結版 `createReplSession` との差分テスト**（§4.5.1）。段階 1 では「一致」を検査する | 段階 2 で「**違いの記録**」（期待値 = 凍結版との差の一覧。1 件ずつ理由つき）。拡張版の退役で消す | S-eval で書き換え / 退役で削除 | 一致 → 記録への書き換えは **P-01 の完了条件に含める**（同じ PR）。削除は台帳の spec が `ext-retire` で検査 | `ext-retire` | S-rpc → S-eval → 退役 |
| **P-03** | **MCP ツールの v1 関門**（§6.1）: 名前・引数・戻り・`tools/list` の 28 本と順序を凍結版と同じにする。付随する互換: 応答の末尾 `(documentDirectory: …)`・IM.6 のエラー文言・debug の `get_log` に積む `[STEP]` の行（§5.3.6）・人間向けのログ行の文言 | v1 の後は**アプリに合わせて変えてよい**（§6.1 の規則で） | 第 1 リリースのタグの後、`apps/OrbitStudio/VERSION` が次の版へ進む | `tests/protocol/mcp-tools-v1.spec.ts`（新設・§6.1）が `VERSION` と定数 `MCP_V1_GATE_UNTIL` を比べ、**自動で**「凍結版と比べる」から「アプリのスナップショットと比べる」へ切り替わる。🔴 この行の危険は逆向き（関門が黙って残り続け、アプリが拡張版の形に縛られる = owner の「過去の資産が後々邪魔をする」）なので、**切り替えを人の記憶に頼らない** | 第 1 リリースの後 | S-mcp |
| **P-04** | **WebView の playhead の暫定の消費者**: `transport.step` の `source` が `null` の間、凍結版の `playhead.ts`（文字列照合）を使う（§1.3・§5.3.6） | `source` を正本にする（#987 の位置情報・#997 の範囲） | 文書の評価で `source` が `null` でないことを gated `native` の 1 本が確かめ、WebView から `playhead.ts` が消えている | WebView の該当モジュールに `PROVISIONAL(P-04)` + **リリースの preflight**（D-11）+ gated `native` の 1 本（S-eval で足す） | `release-1` | A-skeleton → S-eval |
| **P-05** | **daemon が親の死を知らない間の後始末**（#996 が engine 線で入るまで）: アプリの F-12 の経路とハーネスの teardown が、残った daemon を PID で探して止める（§4.4・§12 F-1 / F-12） | daemon が stdin の EOF / 親 PID で自分から終了し、Origin 付きの接続を拒否する（#996）。アプリは残りを**止めずに**、残っていたら `log.line`（error）で知らせる（黙って掃除すると daemon 側の退行を隠す） | #996 が CLOSED になり、アプリの掃除コードが「検出して知らせる」に置き換わっている | アプリの掃除コードに `PROVISIONAL(P-05)` + **リリースの preflight**（D-11）。加えて **#996 に `release-gate` ラベル**を付ける（提案・main が付ける） | `release-1` | A-skeleton → engine 線（#996） |
| **P-06** | **楽器のノートの 5 ms ポーリング**（`midi-scheduler.ts:77-78,188`・`plugin-note-output.ts:25`）。ノートは時刻を持たずに即時で daemon へ送られ、ブロック先頭で鳴る（doc 428 §2） | `ScheduleEvents` で daemon の transport の時刻に置く（doc 428・旧計画 PR-Q-D/E/F） | **T-1（N0-d・§4.6）の判定**が台帳に記録されている。判定が「ゲート」なら #428 が `release-gate` になり、PR-Q-E の E2E-T1 が緑 | 判断そのものの期限: 台帳の spec が、`apps/OrbitStudio/Package.swift` が現れた時点（A-skeleton の開始）で `docs/research/848-timing-baseline.md` に判定の行（`判定: ゲート` か `判定: ゲートにしない`）が無ければ red。判定が「ゲート」なら `release-gate` ラベル（🚪） | `when-exists:apps/OrbitStudio/Package.swift`（判定）/ 判定がゲートなら `release-1` | N-spike（N0-d）→ engine 線 PR-Q |
| **P-07** | **engine の console 出力を in-process で受け取る経路**。`packages/engine` は `[STEP]`・人間向けのログ行・`✓`・`[ERROR]` を `console.log` / `console.error` へ直接書き（`packages/engine/src` の `cli/` 以外で 31 ファイル 156 箇所・`git grep -c` @ `7410dcb0`。例: `rust-engine-player.ts:1656`・`midi-scheduler.ts:174`・`sequence.ts:260`）、出力先を差し込む口が無い。層 2 は engine を in-process で持つので、v1 は **session のプロセスの console を横取りして**行を分類するしか無い（§4.5.1 が評価の単位について棄却したのと同じ形が、評価の単位の外に残る） | engine に**型付きの出力の口**（step / log / diagnostic）を足し、host が注入する。既定は console のまま（凍結版の振る舞いは変わらない・凍結版のリリースは stable のタグから・§10.3） | `packages/session` から console の横取りが消え、`transport.step` と `log.line` が型付きの口から来る | 横取りのコードに `PROVISIONAL(P-07)` + **リリースの preflight**（D-11） | `release-1` | S-rpc（N1-a2）→ S-eval |
| **P-08** | **実測で決める値（置き値）**: `--parent-pid` の確認の周期（§4.4）・中継が上流を待つ上限（§4.7・RL-3）・D-5 の 50 回連続評価の分散の閾値（N2）・F-9 の 1 秒あたりの通知数の閾値（N2）・Swift の行数（§7.1）・T-1 の判定の閾値（m0 + 64 フレーム・§4.6・提案値）・F-12 の自動の再起動をやめる連続失敗の回数と時間の窓（§12） | 実測値と、その出典（日付・commit・ファイル:行） | 値ごとに、定数の横に `measured: <日付> <出典>` のコメントがある | 置き値の定数に `PROVISIONAL(P-08)`。実測したら印を出典のコメントに置き換える。**リリースの preflight**（D-11） | `release-1` | 各束（S-rpc / S-mcp / A-skeleton / A-parity / N-spike） |
| **P-09** | **拡張版と共存する間だけのもの**: ハーネスの `ORBIT_GATED_TARGET=vscode`・`PARITY_BASELINE_TAG` と `native-parity-ledger.ts`・MCP の対応表（§6.1 の adapter）・F-10 の paths の警告・`release.yml`（`.vsix`）・user サイトの「拡張版」の可用性行と (20) の併記・P-02 の差分テスト | 拡張版の退役で消す（owner (20)「どこかでVSIXは退役させます」） | 退役の PR で、これらが消えるか拡張版を前提にしない形になっている | 台帳の spec の `ext-retire`: `packages/vscode-extension/` が無いのに開いた行があれば red（退役の PR そのものが落ちる） | `ext-retire` | 退役（時期は owner） |
| **P-10** | **D-8 の follow-up**: `tests/docs/planning-issue-state.spec.ts` の `DOCUMENTS` に `NATIVE_DEVELOPMENT_MAP.md` と `IMPLEMENTATION_PLAN_NATIVE.md` を足す。2026-09-11 の初版から「main の follow-up」のまま**未実施**（`planning-issue-state.spec.ts:41-44`・§2） | 足してある | `DOCUMENTS` に 2 本が入っている | 台帳の spec: `packages/session/package.json` が現れた時点で `DOCUMENTS` に 2 本が無ければ red（S-rpc の最初の小 PR で入れる） | `when-exists:packages/session/package.json` | S-rpc（N1-a0） |
| **P-11** | **同梱文書の `未リリース（<線>）` マーカー**（別冊 §5.2。版番号が決まるまでの暫定値） | 版番号 | リリースの bump PR で置換されている | **既存の仕組み**: `verify-app.sh` が `check-availability.mjs --release` を呼び、1 件でもあれば落ちる（別冊 §5.4・§6.4）。台帳の spec は検査しない（二重にしない） | 各リリース | R-app / docs |
| **P-12** | **docs 追従ルーチンの 09-18 の暫定行**（「新ライン = 追従対象外」「OrbitStudio（凍結版）」など・別冊 §7.4）。裁定 (18) A で撤回が決まったが、本文はリポジトリの外（cloud の routine）にある | 手順の正本を `docs/development/DOCS_SYNC_ROUTINE.md` に写し（裁定 (21) A）、暫定行を撤回する | `DOCS_SYNC_ROUTINE.md` が在り、暫定行の語（`追従対象外` / `OrbitStudio（凍結版`）が 0 件 | **リリースの preflight**（D-11）: 台帳の spec が release モードで、ファイルの実在と語の 0 件を検査する | `release-1` | docs の連続 PR ③ |
| **P-13** | **(20) の owner の条件が未着手**: 「拡張版の読者が OrbitStudio の記述を自分の手順として読まない」書き方（別冊 §3.4 の見直し） | lint が書き方を強制する | `check-availability.mjs` に規則 **AV-HOST-SCOPE**（`host: both` の章で `OrbitStudio` を含む行は、`- **OrbitStudio**:` で始まる併記の行か、`> **対応**:` に OrbitStudio を含む節の中にしか置けない）が入っている | 台帳の spec: `sites/user/scripts/check-availability.mjs` が現れた時点で規則 ID `AV-HOST-SCOPE` が無ければ red（= docs の連続 PR ① に規則を入れる。② より前） | `when-exists:sites/user/scripts/check-availability.mjs` | docs の連続 PR ① |
| **P-14** | **アプリの版の置き値 `0.1.0-dev`**（計画 §6 (14)） | リリースの版 | タグ = `VERSION` | **既存の仕組み**: リリースの preflight が `app-v<版>` = `VERSION` を強制する（656 §4.4 の形・§9.2 段 1） | 各リリース | R-app |
| **P-15** | **統合ブランチ名の `848-` 仮置き**（計画 §2.1） | 束ごとの issue の番号 | 束の issue が起票され、計画 §2.1 の列が更新されている | 🔴 **仕組みを置けない**: ブランチ名の hook は issue 番号の有無しか見ず、`848` も番号なので通る。代わりに計画 §7 の作業列で、各束の**最初の手順**を「束の issue を起票 → 計画 §2.1 を更新」にした | — | 各束の開始 |
| **P-16** | **凍結版 4.4.0 の `/mcp` の Origin 未検証**（#996 に記録だけ・§4.7） | 凍結の例外として直すか、退役まで残すか（owner） | owner の判断が #996 に記録されている | issue **#996**（OPEN）+ 台帳の spec の `ext-retire` | `ext-retire` | — |
| **P-17** | **Monaco へのパッチ**（N0-a で要ると決まった場合のみ。D-6 の上流の修正 microsoft/vscode#333909 が未マージの間） | 上流の修正を含む Monaco の版へ上げ、パッチを消す | パッチのファイルが無い | 🔴 **期限を機械で切れない**（上流の都合）。代わりに、パッチの適用を Monaco の版に結びつけ、**版を上げた時にパッチが当たらなければ build が落ちる**形にする（N0-a で決める）。パッチのファイルに `PROVISIONAL(P-17)` | `external` | N0-a → 上流 |
| **P-18** | **`protocol:check` が TS 側だけ**（N0-b で生成ツールが決まるまで。クラウドで先に進める S-rpc の N1-a1・計画 §7.1 の C-2） | TS と Swift の両方を生成し、`protocol:check` が両方の差分ゼロを検査する | `protocol/gen/swift/` に生成物があり、N0-b の往復テスト（3 メッセージ）が緑 | 台帳の spec: `apps/OrbitStudio/Package.swift` が現れた時点で `protocol/gen/swift/` が空なら red（Swift のコードが生成物を使い始める前に閉じる） | `when-exists:apps/OrbitStudio/Package.swift` | S-rpc（N1-a1）→ N0-b |
| **P-19** | （2026-10-26・S-rpc の N1-a2 で追加）**スキーマにあって層 2 がまだ実装していないメソッド**。v1 のスキーマ（§5.3）は全メソッドを宣言するが、S-rpc の層 2 が実装するのは `session.evaluate` / `getState` / `getLog` / `shutdown` と `engine.*` だけで、残り（audio・plugin・editor・docs・`session.registerMcp`）は `METHOD_NOT_FOUND`（`data.detail` に「後の束で実装」）を返す | 全メソッドを実装する（S-mcp・S-editor） | `session.evaluate` 以外の C→S メソッドがすべて層 2 のハンドラを持つ | サーバの「未実装」の分岐に `PROVISIONAL(P-19)` + **リリースの preflight**（D-11）。束をまたいで main に入る間の状態なので、S-editor の最後の小 PR で閉じる | `release-1` | S-rpc（N1-a2）→ S-mcp / S-editor |

#### 1.4.2 仕組み — `tests/repo/native-provisional-ledger.ts` と `.spec.ts`（N1-a0 で足す）

- **印の文法**: `PROVISIONAL(P-01)`（コメントの中に置く。TS / Swift は `//`、シェルは `#`）。走査する場所: `packages/session/` `apps/OrbitStudio/` `protocol/` `scripts/` `tests/`（台帳のファイル自身は除く）。形を仮定した grep にしない — 文字列 `PROVISIONAL(` を唯一のアンカーにする（memory `version-sweep-fix-the-number-not-the-shape`）
- **台帳のファイル**: 行ごとに `id` / `title` / `deadline`（上の 4 種。P-15 のように仕組みを置けない行だけ `none` + 理由）/ `state`（`planned` = まだコードに無い・`open` = コードに在る・`closed`）/ `closedBy`（PR 番号。作られずに済んだ行は理由）/ `markerless`（コードに印を置かない行の理由）/ `enforcedBy`（台帳の外の既存の仕組みが強制する行 = P-11・P-14。台帳の spec はその行を検査しない）/ `check`（`when-exists` の行と release モードで評価する関数）
- **検査**（`npm test` で毎回。release モードは `ORBIT_RELEASE_PREFLIGHT=1`）:
  1. コードの印の ID がすべて台帳に在り、その行が `planned` でない（**台帳に無い足場を作れない**・印を入れた PR が行を `open` にする）
  2. `closed` の行の印が 0 件（閉じたのに足場が残っている形を作れない）
  3. `open` の行は、印が 1 つ以上あるか `markerless` の理由を持つ（何も追跡しない行を作れない）
  4. `when-exists` の行: そのパスが在るのに `check` が偽なら red
  5. `ext-retire` の行: `packages/vscode-extension/` が無いのに `open` なら red
  6. **release モード**: `release-1` の行がすべて `closed`（`planned` のままも red — 作られずに済んだなら理由つきで閉じる）、かつ `release-1` の印が 0 件。`verify-app.sh` がこのモードで呼ぶ（§9.2）
  7. 本書 §1.4.1 の表の `P-xx` の集合 = 台帳の `id` の集合（文書と台帳のずれを作らない）
- **最初に入れる時期**: S-rpc の最初の小 PR（N1-a0）。最初の足場（P-01）と同じ PR で入れる。それより前はコードに暫定物が無い
- 行は消さない（`closed` にして残す）。件数のラチェットにはしない（暫定物は増えてよい。増える時に期限と仕組みが要るだけ）

#### 1.4.3 列挙の手段と処分（漏れの証明・memory `absence-claims-need-exhaustive-enumeration`）

**手段**: 改訂前の 4 ファイル（`git show 042906b9:<path>`。下の行番号はこの版）に、発注書の正規表現 `暫定|足場|段階|後で|後から|申し送り|v1 だけ|まで|当面|将来|保留|待ち` を Python の `re` で当てた（**109 行**: 設計 56 / 計画 29 / 地図 8 / 別冊 16）。語を 3 つ足した（`follow-up|未着手|仮`）結果は **117 行**（設計 58 / 計画 30 / 地図 12 / 別冊 17）。さらに「v1 で作らない・後で足す」の言い回しを `v1 では|v1 で|v1 に|v1 の(実装|既定)|MINOR|要るようになっ|日が来たら|再検討` で拾った（**21 行 29 か所**・うち 4 行は前の 117 行と重なる）。対象は和集合の **134 行**。`足場`・`当面`・`v1 だけ` は 0 件だった（「足場」は本改訂で初めて入る語）。
**読み方**: D = 設計・P = 計画・M = 地図・S = 別冊。1 行に語が 2 つ以上あるものも 1 行として数え、処分は 1 行に 1 つだけ付けた。

| 処分 | 行 | 件数 |
|---|---|---|
| **台帳に載せた** | P-01 / P-02: D316 / P-04: D120・D238・D513・P81 / P-05: D141・D287（申し送り・まで）・D386・D901・D912（1 つ目の「まで」）・P135・M115・M296 / P-06: D265・D330（§4.6 を書き直した）/ P-08: D105 / P-09: D861・D1030・S45（拡張版の将来のメンテ = 共存の期間）/ P-10: D108・D159・M23・M121 / P-11: S206 / P-12: D1011・P229・M249・S311・S321・S327・S373 / P-13: D970・S366 / P-14: P225 / P-15: P73・P75 | 36 |
| **裁定で解消した**（「待ち」「保留」が第 1 回・第 2 回の裁定で決まった。本文を裁定済みへ直した） | D6・D80・D440・D945・D1000・D1016（「要るようになってから」）・P33・P65・P85・P95・P208・P214・P218・P220・P232・P233・P237・P239・M132・S6・S12・S364 | 22 |
| **戻れる側の拡張**（今は作らないが、作らないまま最終形として成り立つ。動いている暫定物ではない） | D85・D257・D258・D264・D874・D875・D994・D1008・D1010・M40・S176・S360・S370・D324・D365・D373・D748・D869・D911・D1012・S289・S374・M251・M275・P19（将来のクライアント） | 25 |
| **履歴の記述**（改訂履歴・過去の判定表） | D190・D1040・D1041・P247・P248・P249・P250・M319・S384・S385 | 10 |
| **語の別用法**（「まで」= 範囲・到達、「待ち」= 待機の動作、「後から追える」「仮定」など） | D30・D74・D144・D274・D281・D283・D352・D514・D535・D577・D594・D643・D662・D809・D848・D871・D904・D930・D960・D982・D1001・P20・P94・P219・M9・M19・M98・S204・S358 | 29 |
| **完了条件・作業列に移した**（動く暫定物ではないが、忘れると穴になる確認の仕事） | D458（`engine.stop` が daemon の消滅を待つか・未確認 → 計画 §7 の S-rpc の完了条件）/ P222（(11) の分類を台帳へ転記 → A-parity の完了条件）/ P226・P227（裁定済みの前提で書いてよい・期限なし → docs の連続 PR の順序）/ M159（`must-fix` を A-parity まで付けない → A-parity の束 PR で地図 §3.4 を直す）/ P151（配布の issue の書き直しは起票待ち → R-app の最初の手順） | 6 |
| **v1 の形の確定**（暫定ではなく v1 の決定。v1 の後に変えるなら MINOR / MAJOR の規則に乗る） | D412・D460・D941・M75・P21・P125（D513 の「v1 の実装」は P-04 で数えた）| 6 |

合計は **134 行**（36 + 22 + 25 + 10 + 29 + 6 + 6）で、処分の無い行は 0（スクリプトで照合した: 和集合の各行がちょうど 1 つの処分を持つ）。新しく見つけた暫定物は **P-07**（engine の console 出力）・**P-17**（Monaco のパッチ）・**P-18**（`protocol:check` が TS 側だけ）で、どれも grep の語には掛からず、一次ソースを読むか作業列を組んで見つけた（P-07: `git grep -c "console\.\(log\|error\|warn\)" 7410dcb0 -- packages/engine/src` / P-18: 計画 §7.1 の C-2 が N0-b より先にクラウドで走るため）。**`未確認`・`未実測` は語に入れなかった** — 測定の不在であって、動く暫定物ではない。ただし実測の結果を置き値で埋めた瞬間に暫定物になるので、それは P-08 で受ける。

---

## 2. 現在地（一次情報・本書が変えるもの）— 🔴 2026-10-23 に main `7410dcb0`（拡張 4.4.0）で再測

🔴 **比較元の日付を直した**: 旧版（09-18 改訂）が「09-18 の main」と書いた `1276ab1f` は、**2026-09-14 22:51 +0900 の #943（拡張 4.2.0 リリース）のマージ**である（`git log -1 --format='%h %ad %s' --date=iso 1276ab1f`）。#947〜#962（09-17〜09-18）は `1276ab1f` の祖先ではない（`git merge-base --is-ancestor`）。したがって旧版の値は「4.2.0 タグ直後・#954 / #955 の前」の値で、下の表では **「09-14」列**として残す。同じ手法で `1276ab1f` を測り直すと旧版の値はほぼ再現した（再現しなかったのは「40 ファイル」→ 実測 41 の 1 件と、手法の分からない `orbit-audio-daemon` の行数）。測定コマンドは各行の「根拠」列。`1276ab1f..7410dcb0` は 91 コミット（merge でないもの 57）。

| 事実（10-23・`7410dcb0`） | 09-14（`1276ab1f`・旧版が「09-18」と書いた値） | 根拠 | 本書 |
|---|---|---|---|
| 🔴 拡張は **43 ファイル 10,810 行**（+2 本: `correlated-line-bridge.ts` 128・`evaluate-document-directory.ts` 95）。`extension.ts` 402・`mcp-server.ts` 366。500 行超は `engine-process.ts` 703 / `agent-handlers.ts` 551 / `engine-handlers.ts` 546 の同じ 3 本 | 41 ファイル（旧版は 40 と誤記）10,471 行・412 / 346・683 / 518 / 530 | `git ls-tree -r --name-only 7410dcb0 packages/vscode-extension/src` の直下 `.ts` → 各 `git show … \| wc -l` | §3.1 |
| 🔴 **`vscode` を import するのは 15 ファイル 4,452 行、非依存は 28 ファイル 6,358 行**（依存 15 本の顔ぶれは同じ。`extension-state.ts` は `import type` のみ・`:13`） | 15 本 4,409 行 / 26 本 6,062 行 | 各ファイルを `grep -q "from 'vscode'"`（`require('vscode')` / `from "vscode"` は 0 件） | §3.1 |
| 拡張 → engine は stdin の **`//#` メタ行 8 種**（種類は同じ）。🔴 **`//#documentDirectory` の意味が変わった**（#966・4.4.0）: 値あり = 設定 / **値が空 = 基準をクリア** / **行を省略 = 前回値を保持**の 3 値。REPL セッションが最後の値を持ち続ける**隠れた状態**である | 8 種・2 値（設定 / 省略） | `git grep -ohE "//#[a-zA-Z]+" … \| sort -u` / `repl-mode.ts:66-80`（`extractDocumentDirectoryMeta`）・`:357-365`（`sessionDocumentDirectory`） | §5.3・§5.5（層 2 は状態を持たない） |
| 🔴 engine → 拡張は stdout の **4 系統** + stderr: `✓` / `[STEP] seq argPath atEpochMs`（発行元 2 か所: `rust-engine-player.ts:1656`・`midi-scheduler.ts:174`）/ 1 行 JSON 5 種（`evalMark` `savePluginState` `pluginUi` `engineState` `selectAudioDevice`）/ **人間向けのログ行**（`🎚️ <seq>: play=… (next cycle)` `⚠️` `🎛️` `▶` `⏹` `🔄` `✅ Global …` ほか）/ stderr `[ERROR] …` | 旧版は「3 系統」と書き、人間向けのログ行を数えていなかった（9/14 にも在った） | `engine-handlers.ts:43-155`（`shouldFilterLine` の部分文字列フィルタが「出す / 捨てる」を決め、それが `get_log` の中身になる。#964 はここの退行） | §5.3 `log.line` の `kind` |
| 🔴 requestId 相関ブリッジは **6 ファイル 576 行**: 共通骨格 `correlated-line-bridge.ts` 128 + `device-switch` 116 / `engine-state` 90 / `eval-mark` 91 / `plugin-state` 64 / `plugin-ui` 87。**#757 は凍結版で実装して CLOSED**（`7ef1ce74`・PR #985・2026-10-23）。`device-switch` だけは requestId を持たない FIFO なので骨格に載らない | 5 本 654 行・#757 OPEN | `git ls-tree … \| grep bridge` → `wc -l` / `gh issue view 757 --json state,closedAt` | §3.1（「消える」側の行数） |
| 送信は `writeCodeToEngine()` 1 箇所（`engine-process.ts:647-702`）。🔴 引数が `documentDir: string \| null \| undefined` になった（`null` = 空の `//#documentDirectory` を送って基準をクリア・改行を含む dir は送らず `null` に落とす・#966 / #986）。`global.setDocumentDirectory(...)` の DSL 注入は残る | `:645-673`・2 値 | `engine-process.ts:647-702` | §5.5: `evaluate` の引数 `documentDirectory`（毎回必須）に畳む |
| engine は **VS Code 同梱の Node** で spawn: `child_process.spawn(process.execPath, [enginePath, 'repl', …], { cwd: workspaceRoot, env: { …, ELECTRON_RUN_AS_NODE:'1', ELECTRON_NO_ASAR:'1' } })`。追加の env は `ORBIT_HOST_BUNDLE_ID`（#940）/ `ORBITSCORE_DEBUG` / `ORBIT_CAPTURE_WAV`、引数は `repl [--audio-device X] [--debug]` | 同じ（旧版は env 3 つを扱っていなかった） | `engine-process.ts:346-377,407-416` | §5.3 の env 行・§9 |
| daemon は engine（TS）が spawn し ready 行から port を得て WebSocket 接続。bind は `127.0.0.1:0`。🔴 **daemon の stdin は `'ignore'`** で、親（engine）の死を知る経路が無い | 同じ（stdin は記述なし） | `daemon-client.ts:853-856,913-955` / `server.rs:19` | §4.4・F-1（層 1 への申し送り） |
| daemon バイナリは explicit → env `ORBIT_AUDIO_DAEMON_PATH` → monorepo release → monorepo debug → 拡張同梱 の順（変わらず） | 同じ | `daemon-client.ts:126,146,181-209` | §9 |
| daemon protocol は **v0.3**（変わらず。`git diff --stat 1276ab1f 7410dcb0 -- …/protocol.rs` は空） | v0.3 | `protocol.rs:8` | §0 2.4: アプリ線は触らない |
| 🔴 MCP ツールは **28 個**（+`get_user_doc` / `search_user_docs`・#954 / 4.2.1）。`registerTool(` の字面の数は 12 / 7 / 7 のままで、**字面からツール名を拾うと 24 しか出ない**（docs 系 4 本が `registerDocGetTool` / `registerDocSearchTool` の `name` 変数経由）。実数 28 と `tools/list` の**登録順**は `tests/vscode-extension/mcp-server.spec.ts:396-480` が固定（無条件 23 本 + handler があるときだけ登録する 5 本）。実装は **`OrbitScoreToolHandlers`**（`mcp-types.ts:184-235`）のインタフェース 1 本で受ける。`evaluate_orbitscore` に任意引数 `document_path`（4.4.0） | 26 個 | `git grep -c "registerTool(" … mcp-tools-*.ts` / `mcp-tools-editor.ts:284-330`（`registerDocsTools`） | §5.3・§5.7（列挙の正本を `tools/list` に）・§6 |
| MCP 層で vscode 非依存なのは **8 ファイル 1,885 行**（`mcp-server` 366 / `mcp-tools-editor` 365 / `mcp-docs` 277 / `mcp-tools-plugins` 256 / `mcp-types` 241 / `mcp-tools-engine` 190 / `mcp-sdk` 128 / `mcp-registration` 62）。9 本目の `mcp-register-command.ts`（217）は依存 | 8 ファイル 1,658 行 | `grep -l "from 'vscode'" packages/vscode-extension/src/mcp-*.ts` = `mcp-register-command.ts` のみ | §6 |
| 🔴 MCP の HTTP リスナーは `/mcp` のほかに **`GET /orbitscore/**`（user サイト）・`/orbitscore/dev/**`（dev サイト）・`/docs`（302 → `/orbitscore/dev/`）**を返す。検証は **Host の完全一致の許可リストだけ**で、**Origin を見ていない**（MCP 仕様 2025-11-25 の MUST を満たさない）。CORS ヘッダは返さない | 同じ（旧版は `/mcp` 以外の経路に行が無かった） | `mcp-server.ts:156-163,192-199`（Host）・`:201-272`（静的配信） | §4.7・§5.3 の HTTP 行 |
| gated E2E の MCP クライアントは SDK 非依存の生 HTTP。ハーネスは stock VS Code を `--extensionDevelopmentPath` + `ORBITSCORE_MCP_PORT` で起動し、既定でスクラッチの `tmpRoot` を**ワークスペースとして開く**（`openWorkspace: false` で空の窓） | 同じ | `helpers/mcp-client.ts:1-10` / `orbitstudio-mcp-gated.spec.ts:751,830,836-837` | §4.5（ネイティブ版の「ワークスペース」）・§10.2 |
| 🔴 gated は **v4.4.0 で 56 `it` / 7,855 行**（+7: `#964` 1 / `#966` 2 / `#967` 乱数 4）。**実機の passed 数は未測**。cold-install の gated `vsix-cold-install-gated.spec.ts`（248 行 / 2 `it`・`assertDocsBundled` を含む） | 49 `it` / 7,393 行（2026-09-14 実機 48 passed） | `grep -cE "^ +(it\|test)(\.[a-zA-Z]+)?\(" tests/e2e/orbitstudio-mcp-gated.spec.ts` | D-1（基準タグ v4.4.0） |
| engine（TS）は **24,552 行**（+829・4.3.0 の乱数ピッチ: `parser` +307 / `midi` +343 ほか）。`child_process` の利用は `daemon-client.ts` に閉じる | 23,723 行 | `git ls-tree -r … packages/engine/src \| grep '\.ts$'` → `wc -l` | §4.2 |
| MIDI は `setInterval` 5 ms + `Date.now()`、transport は `setTimeout`（再測せず・裁定 §7 のまま） | 同じ | `midi-scheduler.ts` | §4.6 |
| 拡張の表面: コマンド **16**・キーバインド 1（`cmd+enter`）・設定 **8**・ビュー 2・言語 1・walkthrough 1（変わらず）。🔴 **`registerCommand` は 19** — 差の 3 本は contributes に無い `showCommands`（ステータスバーの click）/ `engineViewToggleEngine` / `engineViewToggleDebug`（Engine ビューの項目の click） | 同じ（旧版は 16 と 19 の差を扱っていなかった） | `package.json` の `contributes` / `extension.ts:152-186` | §5.3・§7.4 |
| VS Code API の使用は 09-14 とほぼ同じ（`activeTextEditor` だけ 11 → 12） | — | `git grep -h -o -E "vscode\.[a-zA-Z]+\.[a-zA-Z]+" … \| sort \| uniq -c` | §7.4 |
| `apps/` `protocol/` `packages/session/` は**存在しない**（`packages/` は `engine` と `vscode-extension` の 2 つ） | 同じ | `git ls-tree --name-only 7410dcb0 packages/` | §8 |
| 同梱バイナリは 7 個 + `Gain.clap`（変わらず） | 同じ | `scripts/copy-daemon-bin.sh:120-135` | §9 |
| Rust は **23 crate・84,603 行**（+`orbit-vst3-preset` 451 行・#982 / #989: VST3 の state を Steinberg 標準の `.vstpreset` で保存）。`engine_wrap.rs` は 6,848 行のまま | 22 crate・83,497 行 | `git ls-tree --name-only 7410dcb0 rust/crates/ \| wc -l` / `.rs` の `wc -l` 合計 | 層 1 は本書の対象外 |
| 🔴 **user サイトは `.vsix` に同梱されている**（4.2.1・#954 / PR #955・2026-09-18）: `npm run build:copy-user-site` が Markdown 45 本 + ビルド済み dist を `packages/vscode-extension/sites/user/`（gitignore 済み）へコピーし、`resolveUserDocsLocation`（モノレポ → `extension-bundle`）が読む。**dev サイトは owner 決定で意図的に同梱しない**（`DEV_DOCS_UNAVAILABLE_MESSAGE` で公開 URL を案内）。cold-install の gated が `get_user_doc`（成功）/ `get_dev_doc`（`isError`）/ `GET /orbitscore/`（200）を検査 | 旧版は「docs は `.vsix` に同梱されていない」と書いた（**旧版の日付当日の 09-18 09:37 に #955 で偽になっていた**） | `scripts/copy-user-site.sh` / `package.json:18,22` / `mcp-server.ts:151-154` / `mcp-docs.ts:38-48` / `vsix-cold-install-gated.spec.ts:155-175` | D-9・別冊 |
| 署名 identity・ASC API キー・順序・entitlements 未確認（変わらず） | 同じ | `656-release-design.md` §5.1-5.3 | §9 |
| per-PR の macOS ランナーは回さない（変わらず） | 同じ | `rust-ci.yml:1-24` | §9.4 |
| `planning-issue-state.spec.ts` が走査する文書は旧地図と旧計画の 2 本だけ（変わらず・**D-8 の follow-up は未実施**） | 同じ | `tests/docs/planning-issue-state.spec.ts:41-44` | D-8 |
| 版: 拡張 **4.4.0**（4.2.0 → 4.2.1 → 4.3.0 → 4.4.0）。`DSL_VERSION 2.0` / `ENGINE_VERSION 2.0.0` は変わらず | 4.2.0 | `packages/vscode-extension/package.json` / `packages/engine/src/version.ts` / `git tag --list 'v4*'` | §0 2.5 |
| `npm test` の件数 | — | **未測** | — |

### 2b. 🔴 改訂判定 — 節ごとに「生き残ったか / 崩れたか」（2026-09-18）

> 改訂（10-23）の注記: この表は 09-18 改訂の判定を**そのまま残した履歴**である。表の中の「09-18 の値」「09-18 再測」は、実際には **09-14 の `1276ab1f`（4.2.0 マージ）**の値（§2）。10-23 の判定は §2c。

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

### 2c. 🔴 改訂判定（2026-10-23）— `7410dcb0` の再測と外部参照の調査で何が崩れたか

判定の軸は §2b と同じ（その節の結論を導いた前提が変わったか）。入力は §2 の再測と、外部参照の調査（Bitwig / SuperCollider / Sonic Pi / MCP 仕様 2025-11-25 / MCP Inspector の勧告 / Jupyter Server / VS Code server / Monaco × WKWebView × IME・2026-10-23）。

| 節 | 判定 | 根拠 | 改訂で入れたもの |
|---|---|---|---|
| §0 前提 | **数値と 1 前提を訂正** | 「4.2.0 で凍結・以後 bug fix のみ」は偽（4.3.0 / 4.4.0 が例外で出た）。比較元 `1276ab1f` は 09-14 | 2.5・§12.2 の行 |
| §1.2 完了条件 | **🔴 D-1 / D-6 / D-9 を書き換え・D-10 を追加** | D-1 の母集団（49 → 56）と根拠（`WORK_LOG.md:452` が別の内容を指す）が崩れた。D-6 は WKWebView が textarea 経路を通る事実（I-1〜I-3）で「動く」が判定にならない。D-9 は前提（同梱されていない）が偽 | D-1・D-6・D-9・D-10 |
| §3 / §3.1 | **生き残る（数値を更新）** | 3 分類の構造は崩れない（移す 4,553 / 新規 95 / 消える 1,437 / WebView 273 / 依存 4 本 1,336 / 書き直す 3,116 = 10,810）。#757 は凍結版で閉じた | §3・§3.1 |
| §4.4 ライフサイクル | **🔴 部分的に崩れた** | 「認証を付けない」の前提 2 つ（`/mcp` は仕様を満たしている / `/rpc` と `/mcp` は露出が同じ）がどちらも偽。F-1 は検知しか無く、子が親の死を知る機構が無い（参照はすべて子の側に機構を持つ） | §4.4・§4.7（脅威モデル）・F-1・F-12 |
| §4.5 ヘッドレス host | **書き足し** | 層 2 が engine を in-process で呼ぶ入口が未設計だった（評価の単位の処理は `repl-mode.ts` の中にしか無い） | §4.5.1・§4.5.2 |
| §5.3 写像表 | **🔴 母集団が崩れた** | ツール 26 → 28・`documentDirectory` の 3 値・`document_path`・stdout 4 系統目・コマンド 19・HTTP 4 経路・環境変数・#987 の `evalId` / `source`。漏れ L1〜L11（§5.3 の表の「漏れ ID」列） | §5.3 を全写像に作り直し・§5.5・§5.7 |
| §6 MCP | **書き足し** | `tools/list` の順序と条件付き 5 本が観測可能な契約（`mcp-server.spec.ts:396-480`）。docs root は `--docs-dir` に（変わらず）、user / dev の 2 系統 | §6 |
| §7.3 WebView の配信元 | **🔴 崩れた** | 「`file://` でも `http://127.0.0.1` でも設計は変わらない」は偽。`file://` は `Origin: null` になり正規のクライアントと区別できない | §7.1・§7.3・§9.2（ATS） |
| §11 棄却案 | **1 行を反転** | 「`/rpc` にだけ token → 意味が無い」の行は、両方に付ける結論に置き換わる | §11 |
| §12 / §13 | **書き足し** | F-1 の機構・F-12・F-13（トークンの漏出）。確信度の行を更新 | §12・§13 |
| §14 | **4 件追加** | #987 Q2・LLM へのトークンの渡し方・`.orbs` を 2 つ開いた時の共有・F-12 の決め事 | (22)〜(25) |

### 2d. 改訂判定（2026-10-26）— owner 裁定 第 2 回で何が崩れたか

再測はしていない（`042906b9` は `7410dcb0` の上に docs だけを積んだ commit で、`git diff --stat 7410dcb0 042906b9` は本書・計画・地図・別冊・`WORK_LOG.md` の 5 ファイルだけ）。入力は裁定（§14.0）と、セキュリティの再検討（2026-10-26・§4.7 に出典）。

| 節 | 判定 | 根拠 | 改訂で入れたもの |
|---|---|---|---|
| §1.1 / §1.2 D-1 | **🔴 崩れた**（関門の範囲） | 裁定 1: 関門は「DSL が実行された結果」と「能力」。拡張版の形は参照 | 到達点・D-1 の分類の規則・D-2 の言葉 |
| §1.2（新） | **書き足し** | 裁定 2 の owner の条件・裁定 4 の「ライブ中に締め出されない」 | §1.4 の台帳・D-11・D-12 |
| §4.5.1 | **書き直し** | 裁定 2 = A 段階を分ける。旧版の「#987 Q2 で決まったら写しを変える」は、#997 の段階 2 に置き換わる | 段階 1 / 段階 2・P-01 / P-02 |
| §4.6 | **🔴 崩れた**（「今は決めない」） | 裁定 5 の owner の意見（タイミングの制御のために速く正確な方がよい）。判断を「いつか」にしない | T-1（N0-d）と判断の規則 |
| §4.7 / §6 / §10.2 / §12 | **🔴 崩れた**（LLM の経路） | 裁定 4 = 中継を同梱。10-23 の (23) の推奨「起動のたびに登録を書き直す」は、owner の懸念の穴そのものだった | 中継・D-12 |
| §5.3 | **基準を変えた** | 裁定 1: 写す基準を「表面」から「能力」へ。`document_path` の改行禁止は引き継がない | §5.3 の冒頭・§5.3.1 |
| §5.3.1 | **書き足し** | 裁定 3: 要求に文書と範囲 | `target` |
| §10 | **位置づけが変わった** | 裁定 1: 仕様書 → 回帰の検算台。裁定 6: 書き直さない | §10 の見出しと §10.1 |
| §14 | **7 件を閉じた** | 第 2 回の裁定 | §14.0 |

---

## 3. 層の責務分割 — どこに何を置き、どこに置かないか

裁定 §3 の 3 層を、**「何が落ちたら何が止まるか」**と**「誰が真実を持つか」**の 2 軸で確定する。

| 層 | プロセス | 持つもの（真実） | 🔴 持たないもの |
|---|---|---|---|
| **1 発音** | `orbit-audio-daemon`（Rust）+ plugin child 群 | オーディオ I/O・サンプル精度スケジューラ・ミキサー・プラグインホスト・capture。protocol v0.3（`protocol.rs:8`・engine 線で進む） | DSL・セッション状態・エディタの何か。**本書で 1 行も変えない**（裁定 2.4） |
| **2 セッション** | `orbitscore session`（Node・`packages/session`・§8）+ 改訂（10-26）: LLM 向けの**中継** `orbitscore relay`（同じパッケージ・別プロセス・§6） | DSL の評価（`InterpreterV2`）・セッション状態・transport・**MCP のツール層**（改訂 10-26: 走るのは中継・§6）・**セッションプロトコルのサーバ**・log ring・診断と補完の**計算**（言語サービス）・プラグインカタログの読み書き・`.orbslog` writer・daemon の起動と監視（既存 `rust-engine-player.ts`）・**subject-block 解決**（§12 補正） | 描画・ウィンドウ・ファイルの open/save（NSDocument）・キーバインド・IME。**`vscode` も `AppKit` も import しない** |
| **3-a 編集（拡張）** | VS Code extension host（凍結） | 現状のまま（stdio + `//#` メタ行で `packages/engine` の REPL を叩く） | 新機能（裁定 2.5）。改訂（10-26・§14.0 (7)）: 層 2 の窓口に**書き直さない**。退役まで今の形で保つ |
| **3-b 編集（アプリ）** | `OrbitStudio.app`（Swift シェル + WKWebView の TS） | ウィンドウ・メニュー・`NSDocument`・環境設定・キーバインド・Monaco・パネルの**描画**・layer 2 の spawn と監視 | DSL の解釈・診断の計算・プラグインカタログの解決・MCP。**GUI からの操作はすべて層 2 の RPC メソッド**（D-4） |

**置き場の判定規則**（迷った時の 1 行）: **「エディタを閉じても意味を持つか」→ 層 2。「見た目・入力・ファイルの入出力か」→ 層 3。「サンプル境界で走るか」→ 層 1。**

- 診断・補完の**計算**を層 2 に置く理由: (a) `get_diagnostics` を MCP から読める片翼状態を作らない（#549 で Fable が捕まえた型の再発防止）(b) 計算はプラグインカタログ（`~/.orbitscore/plugin-catalog.json`）と engine のパーサ（#610 同一パーサ化）に依存し、どちらも層 2 の資産 (c) Monaco の worker を薄く保てる。往復は loopback WebSocket なので補完の体感に影響しない（N0 で実測して閾値を残す）
- requestId bridge（拡張側・10-23 で共通骨格 `correlated-line-bridge.ts` + 5 本 = 6 ファイル 576 行）は**層 2 には持ち込まない**。§5 の wire が request id を運ぶので、相関は RPC クライアント 1 本の仕事になる。改訂: #757（bridge の重複）は**凍結版で共通骨格に畳んで CLOSED**（PR #985・2026-10-23）。新ラインでは骨格ごと不要になる点は変わらない
- 移す先は「描画に近いか」で決める（`playhead.ts` → WebView / それ以外 → 層 2）。🔴 **「pure = そのまま層 2 へ」ではない**（改訂・§2b）。pure でも **host 側の配線**（child-engine の stdout をパースする経路・ブリッジ）は wire で**消える**側であり、移さない。判定は下の §3.1 の表

### 3.1 🔴 拡張 43 ファイルの行き先（2026-10-23 `7410dcb0` 再測・`wc -l` / `grep -l "from 'vscode'"`）

初版の「19 本 pure → そのまま層 2」を、**3 分類**（**移す** = 層 2 の資産 / **消える** = §5 の wire と層 2 の in-process 化で不要になる host 配線 / **書き直す** = 層 3-b の編集面）に置き換える。行数は 10-23 実測（09-14 の値は改訂履歴 §16 の 09-18 行と §2 の「09-14」列）。**依存 / 非依存は `import 'vscode'` の有無で、行き先はそれと一致しない**（pure でも消えるものがあり、依存でも層 2 へ落ちる意味論がある）。

| 行き先 | ファイル（行） | 合計 | 備考 |
|---|---|---|---|
| **移す → 層 2 `packages/session`**（pure 17 本） | MCP 層 8 本: `mcp-server` 366 / `mcp-tools-editor` 365 / `mcp-docs` 277 / `mcp-tools-plugins` 256 / `mcp-types` 241 / `mcp-tools-engine` 190 / `mcp-sdk` 128 / `mcp-registration` 62 ｜ 言語サービス・資産 8 本: `diagnostics-analysis` 496 / `plugin-name-diagnostics` 468 / `wav-analysis` 380 / `plugin-catalog-reader` 349 / `plugin-catalog-completion` 252 / `dsl-completion-context` 229 / `log-ring` 81 / `dsl-method-catalog` 77 ｜ `engine-view` 336（ツリーの整形・pure。WebView へ置く案も可） | **4,553**（1,885 + 2,332 + 336） | `__dirname` 相対でリソースを探す箇所（`mcp-server.ts:151-154` の docs root・`plugin-catalog-reader` のカタログ）は `--docs-dir` 等の起動引数に置き換える（§13 の反証条件） |
| **移す → 層 2**（新規 pure 1 本・10-23 追加） | `evaluate-document-directory` 95（IM.6 の基準ディレクトリの決定・#966。層 2 が同期済みの editor 状態から決めるので層 2・§5.3） | **95** | 純関数（ファイルの存在確認だけ注入）なのでそのまま移せる |
| **移す → 層 2（vscode 依存を剥がしてから）**（依存 4 本の**意味論部分**） | `completion-context` 290（補完の計算。`vscode.CompletionItem` 型を自前型へ）/ `agent-handlers` 551 のうち engine 系（`startEngineForAgent` 等）/ `run-selection` 233 のうち `getLineSubject`（`run-selection.ts:27`・§12 補正）/ `plugin-ui-at-cursor` 262 のうち「カーソル下のプラグイン名 → `(receiver,index)` の解決」（#939・DSL 語彙を receiver に誤解決しない規則 #940 も含む） | 依存 4 本で 1,336。うち層 2 へ落ちるのは約 800（概算・**未実測**） | 残りの editor 系（`openFile` / `setSelection` 等）は**逆方向 `editor.*` リクエストの受け側**（層 3）へ |
| **消える**（pure 9 本 1,437 行・**移さない**）+ **WebView へ**（pure 1 本 273 行） | ブリッジ 6 ファイル 576（共通骨格 `correlated-line-bridge` 128 + 5 本 448。request id が wire に乗る・§5.1）｜ `engine-handlers` 546 / `engine-lifecycle` 291 / `engine-startup-runtime` 24（child `cli-audio.js repl` の stdout / stderr / exit をパースして状態に写す経路。層 2 は `InterpreterV2` を**in-process** に持つので stdout パースが存在しない）｜ `playhead` 273 は消えずに **WebView へ**（`transport.step` の `source` が `null` の間の暫定の消費者・§1.3） | **1,437 が消える / 273 が WebView へ** | 🔴 ただし `engine-handlers.ts` / `engine-lifecycle.ts` の**分類規則**（`shouldFilterLine` の「出す / 捨てる」・stderr は ERROR・`transportStatusText`・stale-process guard の判定）は**意味論として層 2 に写す**。ファイルを移すのではなく、規則を `log.line` の `level` / `kind` と `transport.state` の実装に落とす（§5.3） |
| **書き直す → 層 3-b**（依存 11 本） | `extension` 402（activate 配線）/ `engine-process` 703（spawn・stdin 書き込み・`writeCodeToEngine`。Swift の `SessionProcess` + RPC クライアントに置き換わる）/ `dsl-providers` 417（補完・hover・quick fix の**表示**。quick fix の適用は `editor.editReplace` 経由 = D-4）/ `engine-view-provider` 292（TreeView）/ `flash-config` 255 / `mcp-register-command` 217（QuickPick / InputBox。中身の `mcp-registration` は層 2）/ `playhead-decorations` 200 / `diagnostics-provider` 171（マーカー）/ `plugin-commands` 170 / `extension-state` 159（host のプロセス状態。層 2 が真実を持つので**持ち越さない**）/ `docs-panels` 130 | **3,116** | §7.4 のパリティ表の母集団。`EDITOR_HOST_AND_APP_SIZE.md` の観察「テキスト編集は 1 つも無い」は 10-23 も成立 |

検算（10-23）: 4,553（移す・pure）+ 95（新規 pure）+ 1,336（依存 4 本 = `agent-handlers` 551 + `completion-context` 290 + `run-selection` 233 + `plugin-ui-at-cursor` 262・うち約 800 が層 2 へ）+ 1,437（消える）+ 273（WebView）+ 3,116（書き直す 11 本）= **10,810** ✓（`wc -l` の総計と一致。依存 15 本 4,452 = 1,336 + 3,116 ✓ / 非依存 28 本 6,358 = 4,553 + 95 + 1,437 + 273 ✓）。09-14 と比べて**移す量が +263（+ 新規 95）、消える量が −62**（#757 の共通化で凍結版のブリッジが縮んだ）。**3 分類の構造は生き残る**ので、束 S-mcp / S-editor の概算行数（計画 §2.1）は据え置く。

---

## 4. 🔴 層 2 のプロセス化 — 選択肢と推奨

### 4.1 問い

現行は「拡張 → `node cli-audio.js repl`（stdio）→ daemon」で、層 2 は**拡張プロセスの子**として拡張 1 つに縛られている。ネイティブ化で「クライアント 3 つ・背骨 1 つ」（§3）にするには、層 2 を**どのプロセスに・誰が所有して・どの言語で**置くかを決める。**決めた後に戻れない**のは、所有権（誰が spawn し誰が殺すか）と言語（移植は一方通行）である。

### 4.2 選択肢

| 案 | 形 | 長所 | 短所 | 判定 |
|---|---|---|---|---|
| **A** | Swift アプリの中で JavaScriptCore に TS engine を載せる（in-process） | プロセス 1 つ・IPC 無し | 🔴 UI が落ちると音が止まる（§10「置くべきではない」で撤回済みの型）。JSC に Node API（`fs` / `path` / `ws` / `child_process` / N-API の `@julusian/midi`）が無く 22 ファイル分の shim が要る。拡張と共有できない。改訂: #878 で拡張が **Electron の node**（`ELECTRON_RUN_AS_NODE`）に乗ったのは「Node ランタイムが host に同梱されていた」からで、Swift app にはそれが無い — A を再評価する材料にはならない | **棄却** |
| **B** | **別プロセスの Node**（`packages/session`）。アプリ・拡張・ヘッドレス CLI の**どれか 1 つが所有**する子プロセス | 既存 TS（engine 24,552 行・10-23）を**そのまま**動かせる。プロセス境界で「UI が落ちても音が続く」。daemon と同じ起動流儀（ready 行）で揃う | Node ランタイムを `.app` に同梱する必要（W-22 と同じ判断）。所有者が死ぬとセッションも終わる | ✅ **推奨** |
| **C** | 別プロセスの Node を**ユーザー常駐サービス**にし、クライアントは既知のソケットで発見して attach（誰も所有しない） | 「エディタを閉じてもエージェントが動く」を最も素直に満たす。複数アプリインスタンスで 1 セッション | 🔴 孤児・二重起動・発見・認証の**問題クラスを新設**する（このリポジトリの実測クラス: #624 二重 daemon・#779 shm 孤児・memory `orphan-daemon-pins-coreaudio-context`）。macOS の Unix ソケットパス上限 103 文字（#830 で実測）も踏む | **第 1 リリースでは採らない**（§14 (1)・後から B → C へは足せる。C → B は戻れない） |
| **D** | Rust プロセスに JS エンジン（`rquickjs` / `deno_core`）を埋め込む | Node を捨てられる | 🔴 N-API の native addon（`@julusian/midi`）が載らない / `ws` `fs` `child_process` の ops を自作 / 検証済み挙動をやり直す。裁定 §3 も「Node を完全に捨てたい場合の中間案」 | **棄却（今は）**。B で境界を固定すれば後から差し替えられる |
| **E** | 層 2 を Rust へ移植 | 最終形として最も速い | 🔴 12,600 行の意味論移植。裁定 §3「必要が生じたときに」 | **棄却（今は）** |

### 4.3 推奨 = B（app 所有の Node 子プロセス）+ ヘッドレス host。理由

1. **所有権を 1 つに固定すると、故障モードが今日と同じクラスに収まる。** 今日も engine は拡張の子で、daemon は engine の子（`daemon-client.ts:905`）。B はその親を「拡張」から「アプリ or CLI」に置き換えるだけで、**新しい生存管理を発明しない**。C が持ち込む孤児・発見・二重起動は、このリポジトリが 2026-09 に**何度も踏んだ**クラス（上表）で、第 1 リリースで新設する理由が無い
2. **「エディタを閉じてもエージェントが動く」は B でも満たせる。** ヘッドレス host（`orbitscore session`。改訂 10-26: LLM は中継から入る・§6）を LLM の入口として置く（D-3）。「アプリを閉じた後もセッションを残す」（detach）だけが C でしか出来ないが、それが要るかは owner 裁定（§14 (1)）。B → C は後から**足せる**（発見機構を足すだけ）が、C → B は所有権を後から縛れないので戻れない。**戻れる側に倒す**
3. **言語は変えない。** 境界（§5）を先に固定すれば中身の言語は後で変えられる（裁定 §3）。MIDI スケジューラ・transport を Rust へ落とすのは §9 の「実際に聞こえているか」の実測後（§4.6）。改訂（10-26・裁定 5）: owner は「nodeで評価する形にこだわっていません」とした。**Node の同梱（§14 (3) A）は、いまある TS の層 2 を動かす入れ物として採る**のであって、層 2 の言語を固定する判断ではない。タイミングは §4.6 の T-1 で数字で判断し、評価の実装言語は #997 で開いたまま（通信の形 = §5 が境界なので差し替えられる）

### 4.4 ライフサイクル（B の具体）

```
host（OrbitStudio.app / orbitscore session CLI。VS Code 拡張〔凍結〕は層 2 を使わない・§14 (7)）
  └─ spawn: node <bundle>/session/dist/cli.js session [--runtime-dir <dir>] [--port <N|0>] [--token-file <path>]
              [--docs-dir …] [--web-dir <dir>] [--workspace-root <dir>] [--parent-pid <pid>]
              [--host-bundle-id <id>] [--plugin-catalog <path>] [--plugin-scan-path <path>]
        stdin : パイプ。host は shutdown まで閉じない（EOF = 親の終了・下の F-1 の機構）
        UDS   : <runtime-dir>/session.sock に /rpc を開く（常に）。既定の runtime-dir は
                ~/Library/Application Support/OrbitStudio/run（0700・§4.7）
        TCP   : --port を渡した時だけ 127.0.0.1:<port> に /rpc（WebView 専用）・/app/・/orbitscore/**・/docs を開く
        stdout 1 行目: {"ready":true,"socket":"<path>","port":<bound>|null,"protocol_version":"1.0","token":"<secret>"|null}
                       ← daemon の StartupReady と同型 + socket + token（🔴 token は TCP を開いた時だけ・秘密を含む行・§4.7 の扱い）
        stderr: 起動失敗は {"ready":false,"error":{code,message}}   ← daemon の StartupError と同型（秘密を含めない）
  └─ session が spawn: orbit-audio-daemon（既存 rust-engine-player.ts・変更なし）

LLM クライアント（Claude Code 等。1 回だけ登録・§6.3）
  └─ spawn（stdio）: ~/Library/Application Support/OrbitStudio/bin/orbitstudio-mcp     ← 安定したパスのスタブ（§6.3）
        └─ exec: <app>/Contents/Resources/node/bin/node <app>/Contents/Resources/session/dist/cli.js relay [--runtime-dir <dir>]
              = 中継。それ自身が MCP サーバ（§6）。ツールを呼ばれるたびに <runtime-dir>/session.sock の /rpc へ繋ぐ
```

改訂（10-26・裁定 4）: **`--mcp` を削った**（MCP を話すのは層 2 ではなく中継になった・§6）。**`--port` は WebView のためだけ**にあり、アプリは常に `--port 0` を渡し、headless は既定で TCP を開かない（WebView が無いので要らない）。旧版の ready 行（`port` と `token` だけ）からの変更はこの 3 点で、消費者がテストだけのうちに S-rpc で確定する（一方通行 N-3）。

- **1 host = 1 session = 1 daemon**。host が終了する時は `session.shutdown` を送って待ち、応答が無ければ SIGTERM → SIGKILL。session は自分の daemon を同じ順で畳む（既存 `cli/shutdown.ts` の経路）。**host が SIGKILL で死んだ時に session と daemon が残らない**ことを、gated `native` の teardown で PID オラクル（既存 `orbitAudioDaemonPids()`・`orbitstudio-mcp-gated.spec.ts:544` を helper へ）により確認する（PR-E8 の狭いスライスと同じ形）
- 🔴 **改訂（10-23）: 子が親の死を知る機構を session に持たせる**（F-1。旧版は検知だけで機構が無かった）。
  - **主 = stdin の EOF**: host は session の stdin をパイプで渡し、shutdown まで閉じない。host が SIGKILL で死ぬとカーネルがパイプを閉じ、session は EOF を受ける。session は **stdin がパイプの時だけ** EOF を「親が居なくなった」とみなし、`session.shutdown` と同じ経路で daemon を畳んで終了する（端末や `/dev/null` から手で起動した headless は対象外 — それらの EOF は親の死を意味しない）
  - **補助 = 親 PID の確認**: host が `--parent-pid <pid>` を渡した時だけ、session はその PID の生存を周期的に確かめ（`process.kill(pid, 0)` が `ESRCH`）、居なければ同じ経路で終了する。stdin を誰かが握ったまま親だけが死ぬ形（孫プロセスへの fd の継承）を拾うため。周期は N1 で決める（**未実測**）
  - 前例: sclang は stdin の EOF で終了する（`SC_TerminalClient.cpp:472-482`）/ LSP の `InitializeParams.processId`「親が生きていなければサーバは終了すべき」/ Sonic Pi は keep-alive が途切れたら子を殺す（`daemon.rb:653-690`）。**keep-alive は採らない**: タイマーが遅れると生きている親の子を誤って殺しうる（Sonic Pi の閾値が「40 秒の猶予 + 50 秒以上」と長いことは確認したが、長くした理由は未確認）
  - 現行の engine の REPL にはこの機構が無い: `startREPL` は stdin の close を扱わず `await new Promise(() => {})` で止まり続け（`repl-mode.ts:600-620`）、終了は SIGINT / SIGTERM だけ（`shutdown.ts:94-95`）。したがってこれは `packages/session` に**新しく**置く（`repl-mode.ts` は触らない）
- 🔴 **session → daemon の段にも同じ問題がある**: daemon は stdin `'ignore'` で起動され（`daemon-client.ts:853-856`）、親（session）の死を知る経路を持たない。session が SIGKILL で落ちると daemon が残る（#624 二重 daemon・memory `orphan-daemon-pins-coreaudio-context` のクラス）。daemon 側に stdin の EOF / 親 PID の機構を足すのは**層 1 の変更なので engine 線への申し送り**とする（裁定 2.4・アプリ線は層 1 を触らない。`daemon-client.ts` の `stdio` を `'pipe'` にするだけでは daemon は終了しないので、Rust 側の読み手とセットで engine 線の 1 PR）。それまでは F-1 の PID オラクルが残った daemon を観測し、F-12 の再起動は旧 daemon が居ないことを確かめてから行う（§12）
- **UI（WebView）のリロード・クラッシュでセッションは生き残る**（層 3-b の中で WebView だけが落ちる）。Swift シェル自体が落ちたら上の機構でセッションも終わる — これは B の制約であり、C を採らない代償として明記する。逆に**層 2 だけが落ちてアプリが生きている**場合は F-12（§12）
- **再接続**: WebView は RPC クライアントなので、リロード後は同じ port へ再ハンドシェイクし（トークンは Swift が再注入・§4.7）、`session.getState` で状態（engine 稼働・transport・開いている document 一覧）を取り直す。**状態の真実は層 2**なので、クライアントは何も持ち越さなくてよい
- **リスナー**（改訂 10-26）: **UDS 1 本 + TCP 1 本（任意）**。同じ HTTP サーバの実装で両方を listen し、**`/rpc` のハンドラは 1 つ**で、認証の規則だけをリスナーで分ける（§4.7）。UDS には `/rpc` だけ。TCP には `/rpc`（WebSocket・WebView 専用）・`/app/`（WebView の配信・§7.3）・`/orbitscore/**`（docs・§5.3）・`/docs` を多重化する（§5.2）。🔴 **TCP に `/mcp` は無い**（v1）。旧版（10-23）の「1 リスナーに `/rpc` と `/mcp` を多重化し、両方にトークン + Origin」は、裁定 4（LLM は同梱の中継で繋ぐ）とセキュリティの再検討（2026-10-26）で置き換えた。規則と理由は §4.7
- **LLM の接続**（改訂 10-26）: LLM クライアントは**中継**（§6）を stdio で起動し、中継が UDS の `/rpc` へ繋ぐ。層 2 の再起動・アプリの再起動・TCP のポートの変化は、LLM クライアントからは見えない（§4.7 の「いつ締め出されるか」・D-12）

### 4.5 ヘッドレス host = `orbitscore session`

`packages/engine` の CLI（`parse-arguments.ts`: `repl` / `play` / `midi-run` / `test-sound` …）に **`session` サブコマンドを足す**のではなく、`packages/session` 側の `cli.ts` を入口にする（§8）。理由: `packages/engine` は凍結版の拡張が `engine/dist/cli-audio.js repl` として同梱・実行する（`engine-process.ts:154`）ので、そのファイルに新ラインの機能を足すと**凍結版のビルド成果物が変わる**。

起動引数の `--host-bundle-id` / `--plugin-catalog` / `--plugin-scan-path` は、凍結版が環境変数で渡しているもの（`ORBIT_HOST_BUNDLE_ID`・`engine-process.ts:362-367` / `ORBIT_PLUGIN_CATALOG`・`plugin-catalog.ts:40`・`plugin-catalog-reader.ts:117` / `ORBIT_PLUGIN_SCAN_PATH`・`plugin-catalog-reader.ts:184`）を起動引数に上げたもの。**優先順は「起動引数 → 環境変数 → 既定」**にし、環境変数の経路を残す（テストの注入点を失わない）。`--plugin-catalog` / `--plugin-scan-path` は、engine 側の読み手が `process.env` を呼び出しのたびに読むので（`plugin-catalog.ts:39-41`）、session が起動時に自分の `process.env` へ写し、daemon と plugin child にはそのまま継承させる（engine のコードは変えない）。`--host-bundle-id` は `engine.start` の `hostBundleId` の**既定値**として持ち、engine を起動する時に daemon の env `ORBIT_HOST_BUNDLE_ID` へ渡す（§5.3.2・凍結版の `engine-process.ts:362-367` と同じ渡し方）。アプリはハーネスが自分に設定した環境変数を、同名の起動引数へそのまま写して session に渡す（改訂 10-26: `ORBITSTUDIO_RUNTIME_DIR` → `--runtime-dir` と同じ規則。旧版の例 `ORBITSCORE_MCP_PORT` → `--port` は、TCP の `/mcp` が無くなったので消えた・§5.3.9）。`--host-bundle-id` は**ネイティブ版ではアプリ自身の bundle id**（#940 の「プラグイン窓がホストの前面化に追従する」の追従先・§14 (10)）。

#### 4.5.1 🔴 層 2 が engine を in-process で呼ぶ入口 — 評価の受付口（10-23 追加・10-26 に段階 1 / 段階 2 へ書き直し）

**問いの言い直し**（owner の問い「これはDSLをどこが責任を持つのかということですか？」への答え・裁定シート第 2 回）: DSL の責任の話ではない。DSL の意味（構文の解釈・どう鳴るか）は `packages/engine` の 1 か所にあり、拡張版もアプリも同じものを使う（§10.3）。ここで決めるのは、その手前の**受付口** — 入力をどこで区切り、いつ実行し、何をまとめるか — の置き場と移し方である。

**事実**:

- `InterpreterV2.execute(ir, {documentDirectory, source, sourceFile, evalSource, skipTransportCommands})` はライブラリに在る（`packages/engine/src/interpreter/interpreter-v2.ts:127-145`）。`documentDirectory` を渡せば `execute()` が `global.setDocumentDirectory` を自分で行う（`:212-216`・空文字は基準のクリア）ので、**in-process では拡張の `global.setDocumentDirectory(...)` の DSL 注入（`engine-process.ts:679-688`）は要らない**
- だが **「評価の単位」の処理は `repl-mode.ts` の `createReplSession`（`:357-598`）の中にしか無い**: 行を溜めてパースし、入力の終端（`EOF`）で終わった時だけ「未完」として溜め続ける（#607 / #612）/ 空行 2 連で強制実行 / `//#evalMark` で強制実行して診断を返す（#614）/ `//#evalBegin`・`//#evalEnd` で `AudioLine.beginBatchAll()`・`endBatchAll()`（#611 §5.7）/ 全行を 1 本の FIFO で直列化（#476）/ 60 秒を超えた行の滞留報告（#607）。しかも結果は `console.log('✓')` / `console.error('[ERROR] …')` / 1 行 JSON へ**直接**書かれ、出力先を差し込む口が無い
- `packages/engine/package.json` の `main` は `dist/index.js` だが **`src/index.ts` は存在しない**（engine は「名前で import されるライブラリ」になっていない）。凍結版の拡張は `../engine/dist/…` をパスで読む（`engine-process.ts:154`・`engine-startup-runtime.ts:16`）

**選択肢**（10-23 の起案の比較。裁定シート第 2 回の A / B / C とは記号が違うので、案の名前で呼ぶ）:

| 案 | 形 | 判定 |
|---|---|---|
| 切り出し | 評価の単位を出力先を注入できる関数として `packages/engine` へ移し、`repl-mode.ts` をその薄い adapter にする | DRY・パリティが構造で成り立つ。だが **`repl-mode.ts` を触る**（§10.3「触ったら凍結違反」・F-10）。アプリの区切り方を変えると拡張版も変わる。= 裁定シートの「C 凍結を破って共有」で、**採らない**（§14.0） |
| **写す** | `packages/session/src/eval/` に評価の単位の**写し**を置く。出力は構造化した値（`diagnostics[]`・`ok`・`log.line`）。`repl-mode.ts` は触らない | ✅ **段階 1 の足場として採る**（= 裁定シートの「A 段階を分ける」の前半） |
| そのまま呼ぶ | `createReplSession` を in-process で呼び、`console` を横取りして文字列をパースする | 棄却。グローバルな `console` の横取りは session 自身のログと衝突し、文字列のパースは P-A（§5.1）の欠陥を層 2 の中に持ち込む |

**結論 = 段階を分ける**（owner 裁定 2026-10-26・裁定シート第 2 回の項目 2 = A）。🔴 owner の条件: 「ちゃんと忘れずに最後まで移行をするように」→ §1.4 の台帳の **P-01 / P-02** と完了条件 **D-11**。

| 段階 | 何をするか | 検算 | 束 | 強制 |
|---|---|---|---|---|
| **段階 1（足場）** | 凍結版と**同じ区切り方**の受付口を `packages/session/src/eval/` に書く（写す）。結果は構造化した値。`session.evaluate` の `target`（§5.3.1）は受け取って `transport.step` の帰属にだけ使い、区切りには使わない | **差分テスト = 一致**（下）+ golden が動かない（D-2・S-mcp） | S-rpc の N1-a0（最初の小 PR）。台帳の仕組み（§1.4.2）も同じ PR で入れる | 足場のファイルに `PROVISIONAL(P-01)` |
| **段階 2（置き換え）** | **#997 の評価のかたち**で受付口を置き換える（区切りの単位・途中のエラー・`@import` をまたぐ評価・`target` から区切りを決める）。**独立した PR の束**（S-eval）で入れ、層 2 への移し替え（S-rpc / S-mcp）とは混ぜない | **差分テストを「違いの記録」に書き換える**（期待値 = 凍結版との差の一覧・1 件ずつ理由と #997 の検証ケースへの参照つき）+ golden は動かない（D-2。動いたら owner に確かめる） | **S-eval**（#997 の設計の後・S-editor の後） | 足場が残っていると**リリースの preflight が落ちる**（D-11・`release-1`） |

段階を分ける理由（裁定シートの main の意見と同じ）: 振る舞いを変える変更と変えない移し替えを同じ束に入れると、「移しても音が変わらない」を確かめる機会が二度と来ない（`BUNDLE_BRANCH_WORKFLOW.md` §5.1・計画 §2.2）。段階 1 の受付口は**足場であって、拡張版に縛られる約束ではない** — 段階 2 で置き換わることが最初から決まっている。

段階 1 の写しを採る理由（10-23 から変わらない）: (1) §10.3 は既に「host の入口は 2 本（`repl-mode.ts` は凍結・`packages/session` が新）」と決めており、評価の単位は host の入口の一部である (2) 凍結の規則と F-10 に触れず、**凍結版のビルド成果物は変わらない**（`packages/session` は `.vsix` に入らない。`packages/engine` にも新しいファイルを足さない）(3) 凍結線は owner の例外以外では動かないので、写しが追いかける変更は bug fix に限られる。

🔴 **差分テスト**（P-02・DRY との緊張を「凍結線が退役するまでの意図的な重複」として明示し、放置しない）: 同じ入力（行の列のコーパス: 複数行の文・未完・構文エラー・実行時エラー・空行 2 連・`evalBegin`/`evalEnd` の枠・#607 / #612 / #614 の回帰ケース・**#997 の検証ケース**〔#965 / #620 / #695 / #987 / #630 と owner が挙げる「バグ的な振る舞い」の例〕）を、凍結版の `createReplSession`（`tests/cli/repl-*.spec.ts` 9 本と同じ方法で console と `execute` を観測）と層 2 の受付口へ流し、**`InterpreterV2.execute` への呼び出し列（`code` と options）と診断の列**を比べる。

- **段階 1**: 一致を検査する。凍結版に bug fix が入ってこの検査が red になったら、**同じ PR で写しを直す**
- **段階 2**: 期待値を「凍結版との差の一覧」に書き換える。差の各件は「#997 のどの決定による差か」を持つ。**一覧に無い差が出たら red**（#997 が意図しない振る舞いの変化を黙って入れない）
- 拡張版の退役で消す（P-02・`ext-retire`）

🔴 **評価の単位の外にも、出力先を差し込めない出力がある**（10-26 に一次ソースで確認・台帳 **P-07**）: `packages/engine` は `[STEP]`（`rust-engine-player.ts:1656`・`midi-scheduler.ts:174`）・人間向けのログ行（`sequence.ts:260,272`・`effects-manager.ts:47` ほか）を `console.log` へ直接書く（`cli/` 以外で 31 ファイル 156 箇所・`git grep -c "console\.\(log\|error\|warn\)" 7410dcb0 -- packages/engine/src`）。受付口を写しても、in-process の層 2 は**この出力を console の横取りでしか受け取れない**。v1 はそれで動かす（`PROVISIONAL(P-07)`）が、最終形は engine に型付きの出力の口（step / log / diagnostic）を足して host が注入する形で、S-eval で入れる（既定の出力先は console のまま = 凍結版の振る舞いは変わらない）。

**engine の読み方**: session は `@orbitscore/engine`（workspace 依存）をモジュールのパスで import する。engine に barrel（`src/index.ts`）は**足さない**（凍結版の `.vsix` に入る `engine/dist` に新しいファイルを増やさない）。これで S-rpc の最初の小 PR は「写し + 差分テスト + 台帳の仕組み」になり、**Linux（クラウド）で完結する**（実音も GUI も要らない）。

#### 4.5.2 「最初のワークスペース」のネイティブ版での意味（10-23 追加）

IM.6 の解決順（`document_path` → アクティブな `.orbs` → 最初のワークスペース → 基準なし・`evaluate-document-directory.ts:38-95`）の第 3 候補は、VS Code では「最初のワークスペースフォルダ」である。`NSDocument` のアプリ（§7.1）には「開いているフォルダ」が無いので、次のように決める:

- 層 2 は**ワークスペースを起動引数 `--workspace-root <dir>` でだけ受ける**（無ければ第 3 候補は無い = `null`）。セッションの途中で変える RPC は v1 に置かない（足すなら MINOR）
- **アプリ**: 起動時にフォルダを渡された時（起動引数・Finder からフォルダを開く要求）だけ、そのフォルダを `--workspace-root` として session に渡す。渡されなければ第 3 候補は無い。v1 の GUI に「フォルダを開く」メニューを置くかは A-document で決める（無くても IM.6 は第 2 候補 = 前面のウィンドウの document で足りる）
- **headless**: `--workspace-root` を任意で受ける。**省略時に cwd を暗黙に使わない**（起動した場所で評価結果が変わる隠れた状態を作らない — 3 値の `documentDirectory` を捨てたのと同じ理由・§5.3）
- 理由（パリティ）: gated の共有セッションは**スクラッチの `tmpRoot` をワークスペースとして開いて**起動し（`orbitstudio-mcp-gated.spec.ts:751,830-837` の `openWorkspace`）、IM.6 の第 4 候補だけを確かめる題名（`#966 clears the previous base`）は空の窓で起動する。ハーネスの `native` / `headless` ターゲットは同じ `openWorkspace` を `--workspace-root` の有無に写せばよく、**どの題名がワークスペースの候補に依存しているかを数え上げなくても**パリティが保てる
- 相対の `document_path` もこの値で解決する（無ければ凍結版と同じエラー「relative but no workspace folder is open」）

### 4.6 🔴 タイミングと実行環境（10-26 書き直し・裁定 5。旧見出し「段階移行（言語を変える時の順序・今は決めない）」）

> 「nodeで評価する形にこだわっていません。より早く正確に処理されるならその方が望ましいです。特にタイミングなどの制御があるので。なので、そこも考慮してください。」（owner・裁定シート第 2 回・項目 5）

**タイミングの精度を明示的な目標にする。** 旧版は「§9 の実測が先・本設計はその判断を予約するだけ」と書き、いつ・誰が・何を測るかを決めていなかった。これは §1.4 の言う「後で」の型なので、**名前つきの作業 T-1** にし、判断の規則を先に置く（台帳 **P-06**）。

**今のイベントの経路**（一次ソース。精度を決めているのはどこか）:

| 出来事 | 経路 | 時刻の精度を決めるもの |
|---|---|---|
| `audio()` の `play` | TS が 1 ms の poll（`rust-engine-player.ts:333`）+ 50 ms の lookahead（`:330`）で daemon の時刻 `time_sec` を付けて `PlayAt` を送り、daemon の scheduler が `start_frame` に直す（doc 428 §2・現行は `orbit-audio-core/src/scheduler.rs:267`） | **daemon の側でサンプル精度**。TS の poll の揺れは lookahead の中に吸収される |
| `instrument()` のノート | TS の `MidiScheduler` が **5 ms の poll**（`midi-scheduler.ts:77-78,188`）で発火し、`PluginNoteOn` を**時刻なしで即時**に送る（`plugin-note-output.ts:25`）。daemon はブロック先頭（`sample_offset: 0`・`engine_wrap/notes.rs:66,94` の `plugin_note_on` / `plugin_note_off`）で鳴らす | **TS の poll の揺れ（≤ 5 ms）+ IPC + ブロック長の量子化**がそのまま音に出る（doc 428 §3.4 の案 i の評価「poll ジッタが発音時刻に残る」） |
| 外部 MIDI（RtMidi） | 同じ 5 ms の poll で即時に送る（RtMidi にハードウェア側の予約は無い・`midi-scheduler.ts:8-10`） | poll の揺れ。🔴 **音が daemon を通らないので capture では測れない**（T-1 の対象外。測るならループバックの MIDI 機器が要る） |

**T-1（タイミングの基準測定）= 計画の N0-d**:

| 項目 | 内容 |
|---|---|
| いつ | **N-spike の束**（最初の束・今すぐ着手できる）。Swift にもネイティブ線の進み具合にも依らない — 5 ms の poll は `packages/engine` に在り、凍結版と新ラインで**同じコード**だから、**今のハーネスの `vscode` ターゲットのまま測れる** |
| どこで | **macOS 実機**（capture WAV と実際の音声デバイスが要る）。クラウドでは測れない（計画 §7 の「帰国後にローカル」の列の先頭） |
| 何を鳴らす | 同じ grid（例: 120 BPM の 16 分）に、`audio()` のクリックの列と、`instrument()` の短いノートの列を置く。楽器は `CLAPTestSynth`（`sample_offset` を守る・`rust-spike/clap-test-synth/src/lib.rs:414`・doc 428 §2。守ることは T-1 の先頭で 1 回確かめる — doc 428 §7 E2E-T1 の前提チェックと同じ） |
| 何を測る | **隣接オンセット間隔のばらつき**（doc 428 §7 E2E-T1 と同じ指標。capture の絶対原点が要らない）を、(m0) `audio()` の列・(m1) `instrument()` の列・(m2) m1 を**負荷の下で**（大きな譜面を連続で評価しながら = Node のイベントループが詰まる状況）の 3 つで。値は中央値・p99・最大 |
| どう測る | 🔴 **既存の `onsets` では測れない**: `analyzeWavBuffer` のオンセットは 20 ms の窓・200 ms の最小間隔（`wav-analysis.ts:63-65`）なので 5 ms の揺れは原理的に見えない。gated spec の中にあるサンプル単位の読み手（`readChannelSamples` / `findEnvelopeCrossing`・`orbitstudio-mcp-gated.spec.ts:647-704`・#611 E2E-7）を `tests/e2e/helpers/` へ移し、オンセット = 無音の後に閾値を最初に越えたサンプルの位置で決める |
| 何を残す | `docs/research/848-timing-baseline.md`（数値・日付・commit・デバイスとバッファ長）+ 判定の行（`判定: ゲート` / `判定: ゲートにしない`）。台帳の P-06 がこの行の実在を A-skeleton の開始で検査する（§1.4.1） |
| テストとして残すもの | サンプル単位のオンセットの helper と、測った値を記録する gated の 1 本（前提チェック = `CLAPTestSynth` のオンセットがブロック長より細かい位置に出ること、だけを assert する）。閾値の assert は PR-Q-E の E2E-T1 が red-first で足す（doc 428 §7 のまま） |

**判断の規則**（T-1 の結果で機械的に決める。🔴 閾値は**提案**で、main / owner の確認が要る — 台帳 P-08 の置き値として扱う）:

- **ゲートにする**: m1 の p99 が **m0 の p99 + 64 フレーム**（capture のサンプルレートで。48 kHz なら 1.33 ms）を超えたら、楽器のノートの揺れは `audio()` より大きく、性能の目標（64 フレームの小バッファを edge case ではなく目標にする・memory `orbitscore-daw-grade-small-buffer-goal`）に届いていない。→ **#428 に `release-gate` を付け、PR-Q-A〜F（`ScheduleEvents` と `CancelScheduledEvents`・旧計画 §1.6）を第 1 リリースの条件に入れる**。PR-Q-E の E2E-T1 の受け入れは doc 428 のとおり「現行の baseline を下回る」に加えて、この規則（m1 ≤ m0 + 64 フレーム）を満たすこと
- **ゲートにしない**: 超えなければ数値を記録し、PR-Q は旧計画の順序（ステージ 6）のまま。A-parity で同じ測定を `native` ターゲットで 1 回やり直す（層 2 が in-process になってイベントループの負荷が変わるため）
- **その先（言語の判断）**: PR-Q-E の後は、ノートは daemon の時刻で鳴るので、TS の poll の揺れは音に出なくなる（doc 428 §3.4 案 ii）。残る失敗は **lookahead に間に合わない遅れ**（Node のイベントループが lookahead より長く止まり、`time_sec` が過去になったイベント）だけになる。m2 でこれが観測されたら（p99 が m0 を 64 フレーム以上上回る、または daemon が過去の時刻のイベントを受けた回数が 0 でない — 回数を数える口は doc 428 PR-Q-D への**申し送り（提案）**）、それが**層 2 のスケジューリングを Node の外へ出す引き金**であり、#997 の「実装の置き場（TS か Rust か）」の判断材料として渡す

**言語と実行環境の線引き**:

- タイミングの精度は **daemon の RT の時刻付き queue**（PR-Q）で得る。これは**評価の実装言語と独立**である（TS の poll を残したまま、送る中身に時刻を持たせる）。§4.2 E（層 2 の Rust 移植）とは別の判断で、混ぜない
- **評価の実装言語は #997 で開いたまま**。層 2 の外から見える形は §5 の通信だけなので、評価を Rust に移しても画面と LLM の側は変わらない
- **Node の同梱（§14 (3) A）はそのまま**。Node は目的ではなく、いまある TS の層 2 を動かす入れ物で、言語を見直した時に同梱をやめられる

`AUDIO_ENGINE_CORE_ARCHITECTURE.md` §5 は musical timing を Rust へ移す引き金を「**複数のフロントが同じ timing を使う必要が出た時**」としていた。本書の形ではフロントが 3 つになっても **timing を持つ層 2 は 1 プロセス**で全フロントを受けるので、**この引き金は引かれない**。残る引き金は §9 の実測（聞こえるか）だけである — 改訂（10-26）: それが上の T-1 と判断の規則である。

### 4.7 🔴 脅威モデルと接続の認証（層 1〜3・2026-10-23 新設・旧版の「認証を付けない」を撤回・2026-10-26 に LLM の経路を中継 + UDS へ）

> 🔴 **改訂（10-26・裁定 4）**: owner の裁定は (a) **鍵の検査を残す** (b) **LLM は `.app` に同梱した中継を 1 回だけ登録して繋ぐ**。owner の懸念（原文・第 1 回）: 「基本はローカルのLLMから使うためのものなので、トークンが切れるとかでライブ中に使えなくなるとかがあると困る。」 owner の問い「これはMCPをネットに公開するか？という話？」への答えは「**違う**」— 口はすべてその Mac の中（`127.0.0.1` と UDS）で、問いは「同じ Mac の LLM クライアントに秘密をどう渡すか」だった。
>
> 裁定を受けて、セキュリティの再検討（2026-10-26・一次ソースの調査。下の「出典」）を行い、その推奨で中継の形を決めた。
> - **中継そのものが MCP サーバ**で、層 2 へは **UDS（Unix ドメインソケット）の `/rpc`** で繋ぐ
> - **TCP の `/mcp` は v1 で開かない**
> - TCP に残る `/rpc`（WebView 専用）には Host + Origin + トークンを残し、**Origin が無い接続も拒否する**
>
> 🔴 **裁定 4 の範囲内の実装の選択 — 裁定シートの説明文との差**（main が 2026-10-26 に会話で owner へ説明済み。異論があれば戻す・§14.0）: 第 2 回の説明文は「中継は本人しか読めないファイルから最新のポートと鍵を読み、層 2 の `/mcp` に繋ぐ」だった。本書はこれを上の 3 点 — **UDS のソケット（0700 のディレクトリ・0600 のソケット）**で繋ぐ / TCP の `/mcp` を v1 で開かない / TCP の `/rpc` で Origin の欠落も拒否する — に置き換えた。中継が `initialize` / `tools/list` を自分で答えること、TCP の `/rpc` にトークンを残すことも含めて、main が owner へ説明した。理由は 3 つ:
> 1. 中継が MCP の寿命（`initialize` / `tools/list`）を自分で持たないと、アプリを立ち上げ直した後に繋がり直らない（再検討 2.2・§6.2 の RL-2）。そうすると中継の上流は MCP である必要が無い
> 2. UDS はブラウザから**構造的に届かない**（Web プラットフォームに UDS へ繋ぐ API が無い）。LLM の経路には秘密が 1 つも要らない
> 3. MCP の Security Best Practices が、ローカルのサーバに勧める 2 つ（stdio・権限を絞った UDS）にそのまま一致する
>
> 「鍵の検査を残す」の意図（ブラウザと別のユーザーからの接続を通さない）は、TCP ではトークン + Origin が、UDS ではファイルの権限が担う。

**守るもの**: `session.evaluate` が評価する DSL は (a) ネイティブコードのプラグインを child に読み込む（`instrument()` / `effect()`）(b) 任意のパスの音声ファイルを読む（`audio()`）(c) plugin state をファイルへ書く（`plugin.saveState`）。`session.registerMcp` は LLM クライアントの設定を書き、`editor.saveFile` は document を書く。したがって **`/rpc`（TCP でも UDS でも）に届いた要求は、利用者の権限でのファイルの読み書きとネイティブコードの読み込みに等しい**（Sonic Pi の作者が `/run-code` にトークンを入れた理由と同じ — 調査 P-5・in-thread 2024-06-17）。推論（中・再検討 1.1）: 同じ Mac の別のユーザーが共有の場所に置いたプラグインを読ませれば、別のユーザーから利用者への権限の乗り移りになる。

**実際に起きた事例**（ローカル専用の口でも境界が要る根拠・再検討 1.2）: **CVE-2025-52882**（GHSA-9f65-56v6-gxw7・Claude Code の VS Code / JetBrains 拡張が loopback に開いた WebSocket が認証なし・Origin 未検証で、攻撃者のページを開くだけで接続された。動的ポートは総当たりで見つかった）/ **CVE-2025-49596**（MCP Inspector）/ **CVE-2025-66414**（MCP TS SDK < 1.24.0 の DNS rebinding 保護が既定で無効。勧告の本文は「This issue does not affect servers using stdio transport.」）/ GHSA-9jgg-88mc-972h（webpack-dev-server の WebSocket の Origin 検査が IP アドレスの Origin を常に許可していた）。「Ableton などの DAW は認証していない」は、**DAW がコードを受ける口を既定で開いていない**ことの言い換えで（Link は UDP マルチキャストのテンポ同期・再検討 1.5）、OrbitStudio は LLM のためにその口を開けるので境界が要る。

**攻撃者と経路**:

| # | 攻撃者 | 経路 | 本書の扱い（改訂 10-26） |
|---|---|---|---|
| T-1 | 利用者のブラウザで開いた任意の Web ページ | `new WebSocket("ws://127.0.0.1:<port>/rpc")`（WebSocket のハンドシェイクは CORS の対象外・RFC 6455 §10.2。ephemeral ポートは走査で見つかる）/ DNS rebinding（攻撃者のドメインを 127.0.0.1 へ向け直して same-origin で `fetch`） | **防ぐ**: LLM の経路は **UDS で構造的に届かない**。TCP に残る `/rpc`（WebView 専用）は Host 許可リスト + **Origin 必須**（欠落も拒否）+ トークン |
| T-2 | 同じ Mac の**別のユーザー** | loopback のポートは同じ Mac の全ユーザーから届く | **防ぐ**: UDS は **0700 のディレクトリ + 0600 のソケット**（XNU は UDS の `connect` でソケットファイルへの書き込み権限を検査する・`bsd/kern/uipc_usrreq.c:1345`・再検討 1.4。ディレクトリの 0700 だけでも成立する）。TCP の `/rpc` はトークン（ready 行で親にだけ渡る・トークンファイルは 0600） |
| T-3 | 同じユーザーの別のプロセス | ファイル・メモリを直接読める | **範囲外**（トークンでも UDS でも守れない — UDS の境界は「同じ macOS ユーザー」で T-3 と同じ線）。ただしトークンをログに出さないことで、ログを読める権限しか無いもの（共有したログ・CI の出力）には渡さない |
| T-4 | ネットワーク上の他のマシン | — | `127.0.0.1` と UDS だけ（daemon `server.rs:19`・現行 MCP `mcp-server.ts:316` と同じ） |

**結論を反転した理由**（10-23 の記録。旧 §4.4 / §11 の「`/mcp` が無認証で `evaluate` を開けている以上、`/rpc` にだけ token を付けても意味が無い」の前提 2 つが偽だった）:

1. 現行の `/mcp` は **Host の完全一致の許可リストだけ**を見て Origin を見ていない（`mcp-server.ts:156-163,192-199`）。**MCP 仕様 2025-11-25（Streamable HTTP の Security Warning）の「Servers MUST validate the `Origin` header on all incoming connections」— Origin があって不正なら 403 — を満たしていない**。現状踏襲は仕様違反も引き継ぐことになっていた
2. `/mcp` と `/rpc` は**露出が同じではない**。`/mcp` は、独自ヘッダ（`Mcp-Session-Id` 等）が CORS-safelisted でないので preflight が飛び、サーバが CORS を許可しないことで**偶然**ブラウザから守られている（Fetch 仕様からの推論・確信度中）。**WebSocket の `/rpc` にはこの偶然の防御が無い** — Origin を見なければ任意のページから `session.evaluate` まで届く
3. 参照した前例はすべて **トークン + Origin の両方**を選んでいる: Sonic Pi（全 OSC 要求の第 1 引数にトークン）/ Jupyter Server（トークン既定有効 + WebSocket の `check_origin`）/ VS Code server（`--connection-token`）/ MCP Inspector（CVE-2025-49596 をセッショントークンと Origin 検証の両方で修正）
4. **層 1 の daemon も Origin を見ていない**（`server.rs:76` の `tokio_tungstenite::accept_async` はヘッダ検査を持たず、daemon は `LoadPlugin {path}` を受け付ける・`session/dispatch_plugin.rs:31`）。悪用できるかは未検証（任意の場所にプラグインを置ける攻撃者が要る）

**規則**（改訂 10-26: `/rpc` の**リスナーごと**に分ける。TCP の `/mcp` は v1 に無い。既存の **Host 許可リストは TCP に残す**）:

| 検査 | TCP の `/rpc`（`127.0.0.1:<port>`・WebSocket） | UDS の `/rpc`（`<runtime-dir>/session.sock`・`ws+unix:`） |
|---|---|---|
| 使う者 | **アプリの WebView だけ** | **中継**（LLM の経路・§6）・headless の道具・ハーネス |
| 1 Host | 許可リスト（`127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`）の外 → upgrade を 403 | 該当なし |
| 2 Origin | **許可された値だけ通す。ある + 許可外 → 403 / `null` → 403**（`file://`・sandbox 付き iframe・`data:` が送る値で、正規のクライアントと区別できない）/ 🔴 **無い → 403**（改訂 10-26: 10-23 は「無い → 次へ」だった。非ブラウザのクライアントは UDS へ移ったので、TCP で Origin の欠落を許す理由が消えた） | 該当なし（ブラウザは届かない） |
| 3 トークン | **`session.attach` の params `token`** で検査。不一致・欠落は **close 1008**（policy violation）。attach より前に来たメソッドも close 1008。ブラウザの `WebSocket` はヘッダを付けられず、クエリ文字列はログと履歴に残るので、どちらでも渡さない | **不要**（0700 + 0600 の権限が境界。トークンを足しても、それを読めるのは同じユーザーなので強くならない・再検討 5.1）。`session.attach` の `token` は省略してよい |
| 4 権限 | — | 🔴 session は起動時に `<runtime-dir>` の**所有者が自分で mode が 0700** であることを確かめ、広ければ**起動しない**（`{"ready":false,…}`・`--token-file` の規則と同じ形）。ソケットは 0600 で作る |
| 比較 | 定数時間（`crypto.timingSafeEqual`。長さが違う時も早く返さない） | — |

- 許可する Origin は v1 では **`http://127.0.0.1:<port>`（= `/app/` の配信元・§7.3）だけ**。TCP の `/rpc` を使うのはアプリの WebView だけなので、ほかの Origin を許す理由が無い
- 🔴 **Origin の検査だけに頼らない**（MCP Inspector GHSA-vcc9-3xgm-p9v4 の教訓: Origin の検査が「Origin なし」を通し、さらにトークンを HTML に埋めていたため、DNS rebinding でトークンを盗めた）。TCP ではトークンも必須のまま
- **runtime-dir と UDS のパス**（再検討 2.4）: 既定は `~/Library/Application Support/OrbitStudio/run/session.sock`。macOS の UDS のパスは **103 文字まで**（`sys/un.h:79` の `sun_path[104]`）で、定型部分が 57 文字なので、ユーザー名が 39 文字までなら収まる（2026-10-26 の手元の Mac で 70 文字・再検討 2.4）。🔴 **bind の前に長さを検査し**、超える時は `getconf DARWIN_USER_TEMP_DIR` の下の `OrbitStudio/session.sock` に落とす（`$TMPDIR` の環境変数は親が書き換えることがあるので使わない）。それでも超えれば ready 行に理由を出して起動しない（#830 の「沈黙して落ちる」を繰り返さない。#830 は `$TMPDIR` + 説明的な接頭辞の `--user-data-dir` に置いて 105 文字になった**置き場の選び方**の事故だった）。起動引数 `--runtime-dir` と環境変数 `ORBITSTUDIO_RUNTIME_DIR` で場所を変えられる（ハーネスと headless の分離・§10.2）
- **取り残しと二重起動**: 起動時に既存のソケットへ `connect` し、`ECONNREFUSED` なら unlink して bind する。**繋がれば別のセッションが動いている**ので、理由を ready 行に出して起動しない（アプリと headless を同時に使う時は `--runtime-dir` を分ける）。終了時はソケットを unlink する
- **トークン**（TCP の `/rpc` だけ）: session が起動ごとに生成する（暗号論的乱数・32 バイト以上）。`--token-file <path>` が渡されたら、その中身を使う（ファイルが所有者以外に読めるパーミッションなら起動しない = `{"ready":false,…}`）。**アプリは常に `--token-file` を渡す**: アプリが自分の寿命の間だけ作る 0600 のファイルで、F-12 の再起動で同じトークンを使うため（§12）。**時間での失効は無い**。改訂（10-26）: 10-23 の `ORBITSCORE_SESSION_TOKEN_FILE`（ハーネスがトークンを知る経路）は**削った** — ハーネスは中継から UDS で入るので、トークンを知る必要が無い（§10.2）。**ready 行で親へ渡す**（argv は `ps` に見え、環境変数は子へ継承されるので使わない — VS Code server が `--connection-token-file` を用意しているのと同じ理由）
- **`/rpc` のハンドラは 1 つ**: Node の HTTP サーバは TCP とパスの両方で listen でき、`ws` 8.21.0 は `ws+unix:` を話す（`node_modules/ws/lib/websocket.js:722`・再検討 2.4）。認証の規則だけをリスナーで分け、メソッドの実装を 2 つにしない
- 🔴 **トークンを配信する HTML に埋め込まない**（GHSA-vcc9）。WebView へは **Swift から `WKUserScript`（`forMainFrameOnly: true`）で注入**し、`/app/` の WebView は `/app/` の外へ遷移させない（外部のリンクは既定のブラウザで開く）— 遷移先のページにも注入されるのを防ぐ。トークンを Web storage（`localStorage` / `sessionStorage`）と cookie に置かない（同じオリジンのページ = docs から読める）
- 🔴 **API と同じオリジンで信頼できないコンテンツを配らない**（GHSA-6x67-4w4w-9f3w: プロキシと同じオリジンで信頼できないページを配ったため、Origin 検証が意味を失った）。docs を同じオリジンに置く判断は下
- 🔴 **ready 行と attach の params は秘密**: ログ・log ring（`get_log`）・アプリのログファイル・テストの失敗メッセージに出さない（下の「漏れる経路」）。D-10 が grep で検査する
- **静的配信（`/app/`・`/orbitscore/**`・`/docs`）はトークンを要らない**: 中身は公開しているもの（`/orbitscore/**` は GitHub Pages と同じ）か、秘密を含まない UI の bundle。Host 許可リストは掛ける。`/app/` の応答には `Content-Security-Policy: frame-ancestors 'none'` を付け、他のページの iframe に載せない

**docs の同一オリジン配信（判断）**: `/orbitscore/**` を `/rpc`・`/app/` と**同じオリジンに置いてよい**。条件は 3 つ: (1) 配るのは**自分たちがビルドした第一者のコンテンツだけ**（署名済み `.app` の `Contents/Resources/docs/`、または開発者が `--docs-dir` で指したモノレポのチェックアウト）。利用者由来・ダウンロードした内容を同じリスナーで配らない — 別冊 §6.5 の上書きディレクトリ（U-B）を有効にする日が来たら、**別のオリジン（別のリスナー）**で配るか内容の署名を確かめる (2) Docs パネルは **`/app/` とは別の WKWebView** で開く（同じオリジンの iframe にすると、docs のページから `window.parent` 経由で RPC クライアントに触れる。凍結版の Dev Docs パネルは iframe で包んでいる・`docs-panels.ts:63-113`）(3) docs の応答に CSP を付ける（第一者の docs に XSS が入った時の被害を `/app/` に及ぼさない）。理由: トークンは attach で要るので、docs のページが同じオリジンでも**トークンを持たない限り RPC は進まない**。残る穴は「第一者 docs の XSS + トークンへの到達経路」で、(2) と「Web storage に置かない」で到達経路を断つ。即座の穴は無いと判断した（確信度中: WKWebView の別インスタンス間で JS の参照が無いことは WebKit の通常の振る舞いからの推論で、N2 で確かめる）。

**漏れる経路**（現行コードの写しで再生産しやすいもの）:

| 現行の箇所 | 写すと何が漏れるか | 規則 |
|---|---|---|
| debug 起動で子の stdout を**生のまま**出力チャネルへ流す（`engine-handlers.ts:325` の `outputChannel?.append(output)` → `tapOutputIntoLogRing`・`log-ring.ts:60-81` → `get_log`） | host が session の stdout を同じ形で転写すると、**1 行目の ready 行（トークン）**が log ring とログファイルに入る | host は stdout の 1 行目を ready 行として**消費して捨てる**（転写しない）。session は ready 行の後に stdout へ何も書かない（ログは stderr か `log.line`） |
| 壊れた envelope を原文ごと警告する（`engine-handlers.ts:254-281` の `⚠️ received a malformed … line: ${rawLine}`） | 「ready 行が読めない」時に原文を出すと、壊れ方によってはトークンが残る | ready 行のパースの失敗は**長さと理由だけ**を出す |
| debug で送るコードを全文ログする（`engine-process.ts:697-700` の `📤 Sending: ${JSON.stringify(codeToSend)}`） | RPC の送受信を debug で全文ログする実装を入れると、`session.attach` の params（トークン）が出る | debug のフレームの echo は `session.attach` の params を伏せる（クライアントとサーバの両方） |
| 拒否のログ（`mcp-server.ts:196` の `invalid Host header: ${host}`） | 同じ形で `Authorization` や attach の値を出すと漏れる | 拒否のログは**理由だけ**（例: `token mismatch`）。値を出さない |
| daemon の ready 行の読み手（`daemon-client.ts:913-955`） | — | **漏れない形の手本**: 成功した ready 行はどこにも書かず、JSON でない前置行は `unexpected-stdout` の event に回し、`DaemonStartupError` に入れるのは stderr だけ。session の ready 行の読み手（Swift・ハーネス）はこの形に倣う |
| ハーネスの assertion | `expect(…, readyLine)` のように ready 行を失敗メッセージに入れると、テストのログに出る | ready 行とトークンを assertion のメッセージに入れない |

#### 4.7.1 🔴 いつ LLM が締め出されるか（10-26 新設・裁定 4・完了条件 D-12）

**締め出しの本体は「トークンが切れること」ではなかった**（再検討 2.0）。10-23 の設計のトークンに時間の失効は無い。締め出しを起こすのは、**アプリの起動ごとに変わる値 × HTTP の登録 × Claude Code の再接続の上限**の組み合わせである。Claude Code の MCP の文書（「Automatic reconnection」・取得 2026-10-26）の上限:
- HTTP の途中切断は 1 秒から倍々で 5 回（待ちの合計は約 31 秒）で打ち切り
- HTTP の初回接続の失敗は 3 回で打ち切り
- stdio のプロセスが途中で終わった時は、対話セッションでは手動で戻す

傍証（実測・2026-10-26）: このセッションの起動時に、トークンの無い拡張版 4.4.0 の HTTP `/mcp`（`.mcp.json:3-6`・固定ポート 39123）が `ECONNREFUSED` で落ちた。拡張が動いていなかったためで、**トークンを外しても締め出しは消えない**。

したがって「演奏の途中で人の操作を要しない」の条件は 1 つ: **Claude Code が握っているもの（中継の stdio のプロセス）が、アプリの側に何が起きても終わらず、認証エラーも not-found も返さないこと**。これを、Claude Code の再接続の方針ではなく**私たちが出荷するコードの中**（中継の規則 RL-1〜RL-8・§6.2）で保証する。

| # | 出来事 | LLM から見て | 人の操作 | 確かめる手段 |
|---|---|---|---|---|
| E1 | **演奏中**（時間が経つ） | 何も起きない（時間での失効が無い。LLM の経路にトークンが無い） | 不要 | — |
| E2 | **F-12**（層 2 だけが落ちて、アプリが立ち上げ直す） | 実行中だった 1 回の呼び出しだけが「実行されたか不明」で返り（RL-4）、次の呼び出しから通る | 不要 | unit（Linux）: 層 2 を `kill -9` → 起動し直す。**中継の PID が変わらず**、次の `tools/call` が通る（RL-1・RL-3） |
| E3 | **アプリの立ち上げ直し**（クラッシュの後に人が開き直す・終了して開き直す） | その間の呼び出しは `isError`「OrbitStudio が起動していない / 再起動中」（RL-3）。開き直した後の呼び出しから通る | 不要（アプリを開き直すことだけ） | unit: 層 2 が無い間に `tools/call` → `isError` と文言。層 2 を起動 → 次の呼び出しが通る（クライアントは何もしない）+ gated `native`: アプリを終了して起動し直し、同じ中継のプロセスで次の呼び出しが通る |
| E4 | **スリープからの復帰** | 影響なし（パイプと UDS はカーネルの中・推論・中・**未実測**） | 不要 | 🔴 自動化できない（機械をスリープさせる）。N2 で owner / main が 1 回確かめ、`WORK_LOG` に残す |
| E5 | **Claude Code の再起動** | 中継が新しく起動し、`tools/list` を中継が自分で答える | 不要 | E6 と同じ |
| E6 | **Claude Code をアプリより先に起動** | `initialize` / `tools/list` は中継が上流なしで答え（RL-2）、呼び出しはアプリが起動するまで `isError` | 不要 | unit: 層 2 を起動しないまま `tools/list` が 28 本を §6 の順序で返す。`server/discover` への応答が即時（時間を測る・RL-2） |
| E7 | TCP のポート・トークンの変化 | 影響なし（LLM の経路は UDS で、ポートもトークンも使わない） | 不要 | — |
| E8 | アプリの自動更新（裁定 (5) B）で RPC の **MAJOR** が変わった | `isError`「OrbitStudio が更新された。`/mcp` で orbitstudio を再接続」（RL-5）。MINOR だけなら自動 | 🔴 **1 回**（例外・下） | unit: 版を偽った層 2 に繋ぐ → 文言・中継は生きている |
| E9 | `.app` の移動・App Translocation | スタブがアプリを解決し直す（§6.3） | 不要（**未実測**・N0-c） | N0-c |
| E10 | **中継のプロセス自身の異常終了** | Claude Code の対話セッションでは failed（stdio の終了は手動復帰） | 🔴 **要る**（`/mcp` で再接続・例外・下） | 中継を小さく保ち（RL-8）、RL-1 の検査で「上流の失敗で終わらない」を守る |
| E11 | 評価の途中で層 2 が落ちる | 「実行されたか不明」を返し、**再送しない**（RL-4・二重に鳴らさない） | 不要 | unit: 層 2 を応答の前に落とす → 不明の文言・`session.evaluate` の到着は高々 1 回 |
| E12 | headless とアプリを同じ runtime-dir で同時に起動 | 2 つ目が理由つきで起動しない | — | unit |
| E13 | Claude Code を複数同時に使う | 中継が複数になり、層 2 の FIFO 1 本に並ぶ（§5.6） | 不要 | — |

🔴 **例外は 2 つだけ**: **E8**（MAJOR を変える更新の後に 1 回）と **E10**（中継の異常終了）。どちらも演奏の途中に**ふつうに起きる出来事ではない** — 更新は演奏の外で入れ、中継は小さく保って上流の失敗で終わらない。owner が挙げた 5 つの場面（演奏中 = E1・F-12 = E2・アプリの立ち上げ直し = E3・スリープ復帰 = E4・Claude Code の再起動 = E5）は、**すべて人の操作なしに戻る**（D-12）。

**出典**（セキュリティの再検討・2026-10-26。取得はすべて同日。確信度は再検討のまま）:

- MCP 仕様 2025-11-25 の Transports「Clients SHOULD support stdio whenever possible」と Streamable HTTP の Security Warning（`specification/2025-11-25/basic/transports.mdx:15,76-84`・高）
- 同 Authorization「Implementations using an STDIO transport SHOULD NOT follow this specification, and instead retrieve credentials from the environment.」（`basic/authorization.mdx:17-23`・高）
- MCP Security Best Practices「Local MCP Server Compromise」— ローカルのサーバは stdio を使うか、HTTP なら認可トークンか「unix domain sockets or other IPC mechanisms with restricted access」（`docs/docs/2025-11-25/tutorials/security/security_best_practices.mdx:678-686`・高）
- Claude Code の MCP の文書 https://code.claude.com/docs/en/mcp — 再接続・スコープ・`${VAR}` の展開・stdio の止め方（高）。手元の CLI は 2.1.309
- 勧告: GHSA-9f65-56v6-gxw7 / CVE-2025-52882・GHSA-w48q-cv73-mx4w / CVE-2025-66414・GHSA-9jgg-88mc-972h・GHSA-vcc9-3xgm-p9v4・GHSA-6x67-4w4w-9f3w（高）
- 前例の形（再検討 3.4）: Xcode は `.app` の中のパスを登録させず `xcrun mcpbridge`（stdio の橋）を登録させる（Apple「Giving external agents access to Xcode」・高）/ ableton-mcp と blender-mcp の stdio サーバは、アプリが起動していなくても終了せず、ツールごとに繋ぎ直す（ただし上流は無認証の TCP・高）/ JetBrains の stdio ランナーは上流が閉じると stdio も閉じる（`McpStdioRunner.kt:78-83`・反例・高）/ Jupyter Server は UDS で待ち受けられ（`sock_mode` 既定 0600）、発見ファイルを 0600 で書く（高）
- XNU `bsd/kern/uipc_usrreq.c:1345`（UDS の `connect` の書き込み権限の検査。出荷された macOS のビルドとの一致は**未確認**）

**未確認のまま残すもの**（再検討の「未確認事項」から、本書の判断に効くもの）: Claude Code が HTTP のセッションの喪失（404）の後に自動で `initialize` し直すか（本書の形では効かない）/ Xcode の `mcpbridge` が途中で Xcode が再起動した時にどうするか / スタブがバンドル ID でアプリを解決する時の App Translocation の扱い（N0-c）/ 中継の起動時間と、上流を待つ上限の値（N1・台帳 P-08）/ スリープ復帰の振る舞い（E4）/ Codex CLI・Claude Desktop の再接続の方針（中継が終わらない限り効かない）。

**層 1 への申し送り（engine 線）**: daemon の WebSocket（`server.rs:76`）にも Origin 検証が無く、`LoadPlugin {path}` を受け付ける。848 は層 1 を触らない（裁定 2.4）ので、engine 線への申し送りとして 1 行で書く — 「daemon の accept を `accept_hdr_async` にして **Origin ヘッダのある接続を拒否**する（daemon のクライアントは層 2 の Node だけで、Origin を付けない）。あわせて F-1 の daemon 側の機構（§4.4）」。出荷済みの拡張 4.4.0 の同じ問題（`/mcp` と daemon の Origin 未検証）は **#996** に起票した（owner 裁定 2026-10-26・§14.0）。daemon の Origin 拒否と親の死を知る機構を engine 線で直し、拡張の `/mcp` は記録だけ（直すかは凍結の例外として別に決める）。

---

## 5. 🔴 セッションプロトコル — 作り直す

### 5.1 選択肢

| 案 | 形 | 長所 | 短所 | 判定 |
|---|---|---|---|---|
| **P-A** | 現行 `//#` メタ行 + stdout 行を**流用**し、Swift 側でも同じ文字列パースを実装 | 層 2 の変更ゼロ | 🔴 1 チャンネル（stdin/stdout）なので**複数クライアントに配れない**。相関ブリッジ（凍結版は #757 で共通骨格 + 5 本に畳んだ）と chunk 境界の欠陥（#773 / #777）を Swift でもう一度作ることになる。型が無い（スキーマから生成できない） | **棄却** |
| **P-B** | **型付き双方向 JSON-RPC 2.0 over WebSocket**（`/rpc`）。リクエスト id・メソッド・params・**サーバ → クライアントのリクエスト**（エディタ操作の逆方向）・通知（イベント） | request id が wire にあるので相関ブリッジが消える。複数クライアント可。スキーマ 1 本から TS / Swift / Rust を生成。daemon protocol（v0.3・`protocol.rs:8`）と同じ流儀（handshake + `protocol_version` + `capabilities`） | プロトコルを設計・維持する費用。**一方通行**（クライアントが増えた後は変えにくい） | ✅ **推奨** |
| **P-C** | **MCP そのものを GUI のプロトコルにする**（アプリは MCP クライアントの 1 つ） | 表面が 1 つ | 🔴 `open_file` / `run_selection` / `set_selection` / `edit_replace` / `get_document_text` / `save_file` / `get_editor_state` / `configure_flash` は**サーバがエディタに頼む**操作で、MCP はサーバ → クライアントのツール呼び出しを持たない（sampling / elicitation は別物）。playhead の `[STEP]`（ms 単位・高頻度）を MCP 通知で運ぶ設計は無い。`get_log` は 500 行窓のポーリング | **棄却**。ただし **MCP ツールは P-B のメソッドの薄い写し**にする（D-4） |
| **P-D** | LSP を層 2 に実装し Monaco を LSP クライアントにする | 補完・診断の型が業界標準 | Monaco に LSP クライアントは同梱されない（`monaco-languageclient` は VS Code の shim を持ち込む）。LSP は評価・transport・プラグイン UI を運べないので**結局 P-B も要る** | **棄却**。document 同期のメソッド形だけ LSP に倣う（§5.5） |

### 5.2 P-B の骨格

```
transport   : WebSocket。同じ /rpc を 2 つのリスナーで受ける（改訂 10-26・§4.4・§4.7）:
              UDS  ws+unix:<runtime-dir>/session.sock:/rpc   ← 中継（LLM の経路）・headless の道具・ハーネス
              TCP  ws://127.0.0.1:<port>/rpc                  ← アプリの WebView だけ。同じ TCP リスナーに
                   /app/（WebView の配信・§7.3）・/orbitscore/**（docs・§5.3）。🔴 /mcp は v1 に無い（MCP は中継・§6）
framing     : JSON-RPC 2.0。1 テキストフレーム = 1 メッセージ（chunk 境界の問題は WebSocket のフレーミングで消える・#773 のクラスを構造で潰す）
security    : TCP では upgrade の時にサーバが Host と Origin（欠落も拒否）を検査し、不可なら 403 で upgrade しない（§4.7。改訂 10-23・10-26）。
              UDS ではファイルの権限が境界（0700 のディレクトリ・0600 のソケット）
handshake   : 接続直後にサーバが {"jsonrpc":"2.0","method":"session.hello","params":{protocol_version:"1.0",session_version,capabilities:[…]}}
              （hello は秘密を含まない）
              クライアントは session.attach({token, client:{name,version}, capabilities:["editor"|"observer"|…]}) → {clientId}
              TCP: token の欠落・不一致と、attach より前に来たメソッドは close 1008（§4.7）/ UDS: token は省略してよい（来ても検査しない）。
              attach より前に来たメソッドは UDS でも close 1008（握手の順序はリスナーに依らない）
versioning  : protocol_version は "MAJOR.MINOR"。MINOR = 追加のみ（新メソッド・新省略可能フィールド）。MAJOR = 破壊。
              🔴 不一致は黙って縮退せず attach を拒否する（strict・#136 の原則）。app と session は同じ .app に同梱されるので
              実運用では常に一致し、不一致は「ビルドの混線」= バグとして早く見える
schema      : protocol/session/v1/*.schema.json（JSON Schema 2020-12）を単一の真実にし、TS 型・Swift Codable を生成（§5.8）
```

**なぜ WebSocket か（stdio / Unix ソケットとの比較）**: stdio は親しか繋げない（複数クライアント不可）。Unix ソケットは macOS のパス上限 103 文字を踏む（#830 で実測・`orbitstudio-mcp-gated.spec.ts:103`）。TCP loopback は daemon（`server.rs:19`）と MCP（`mcp-server.ts`）が既に使っており、Swift は `URLSessionWebSocketTask`・WebView は `WebSocket`・Node は `ws`（既存依存）で**新しい依存が 1 つも増えない**。改訂（10-26）: 上の「Unix ソケットは 103 文字を踏む」は**置き場の選び方**の問題で（#830 は `$TMPDIR` + 説明的な接頭辞の下に置いて 105 文字になった）、`~/Library/Application Support/OrbitStudio/run/` の下なら通常は収まる（§4.7 の長さの検査と退避先）。そこで LLM の経路は UDS にした（ブラウザから構造的に届かない）。**WebView は UDS を話せない**ので、WebView の経路は TCP のまま。framing は両方とも WebSocket の 1 フレーム = 1 メッセージで同じ。🔴 改訂（10-26・main の審査）: **Swift のシェル自身が層 2 に繋ぐ時（`session.shutdown`・F-12 の再 attach・状態の監視）は UDS を使う**（非ブラウザのクライアントなので。`URLSessionWebSocketTask` は UDS を話せないので、`Network.framework` の `NWConnection` で UDS の上に WebSocket を張るか、HTTP の upgrade を自前で行う — 手段は A-skeleton で実測）。TCP の `/rpc` は WebView 専用で、Origin の欠落を拒否する規則（§4.7）は Swift のシェルにかからない。UDS で張れないと分かった場合の退避は「Swift が `Origin: http://127.0.0.1:<port>` を明示して TCP に繋ぐ」（規則を緩めない）

### 5.3 メソッド一覧（v1・現行表面の写像）— 🔴 2026-10-23 に全写像として作り直した

名前空間は `session.* / engine.* / audio.* / plugin.* / editor.* / docs.* / transport.* / log.*`。**基準タグ（`PARITY_BASELINE_TAG` = v4.4.0・§1.2 D-1）時点の現行表面をすべて写す**ことで、不在（写し漏れ）を表で証明する。母集団は **MCP ツール 28 + メタ行 8 + stdout 4 系統 + stderr + コマンド 19（contributes 16 + 登録のみ 3）+ HTTP 4 経路 + 環境変数・起動引数**（列挙の手段は §5.7）。**各行は「写す先」か「写さない（理由）」を持つ**。「漏れ」列の L1〜L11 は、10-23 の再測で旧表に行が無かったと分かった表面（新規 4: L1〜L4 / 以前から 7: L5〜L11）。L6（`tools/list` の登録順と条件付き 5 本）だけはメソッドの写像ではなく MCP の契約なので §6 に置いた。

🔴 **改訂（10-26・裁定 1）: 写す基準は「表面」ではなく「能力」**。表の各行が守るのは、その行で人か LLM が**できること**（評価する・鳴らす・観測する・保存する…）であって、拡張版の表面の形ではない。行ごとの扱いは 4 つ:

| 扱い | 何 | この表での例 |
|---|---|---|
| **関門（守る）** | DSL が実行された結果（音・診断・状態）と能力 | `session.evaluate` の意味・`plugin.saveState` の保存と復元・`docs.*` で読めること |
| **関門（v1 だけ）** | MCP ツールの名前・引数・戻り（§6.1） | `evaluate_orbitscore` の応答の末尾 `(documentDirectory: …)`・IM.6 のエラー文言・`tools/list` の 28 本と順序 |
| **参照（作り直してよい）** | 評価の区切り方・画面・パネル・コマンドの構成・ログの文言 | §5.3.7 のコマンドの置き場・§5.3.6 の人間向けのログ行（v1 の間は `get_log` の戻りとして関門に入る） |
| **引き継がない** | 拡張版の通信方式から来た制約・VS Code 固有の表面 | `document_path` の改行禁止（§5.3.1）・`//#evalBegin` / `//#evalEnd`・`ELECTRON_*`・`showCommands` |

「写さない」と書いた行は、能力が別の行で保たれていることを確かめてから落とす（例: `✓` は `ok` に吸収）。

#### 5.3.1 評価（`session.evaluate`）— 状態を持たない

```
session.evaluate (C→S)
  params : { code: string,
             documentDirectory: string | null,      ← 🔴 毎回必須。null = 基準なし
             source: "human" | "agent",
             target?: { uri: string,                ← 🔴 10-26 追加（省略可能）。どの文書の評価か。editor.didOpen の uri と同じ形（file: の URI）
                        version?: number,           ← range を付ける時は必須。editor.didChange の version（どの版の文書の範囲か）
                        range?: { start: { line: number, character: number },
                                  end:   { line: number, character: number } } },  ← LSP の Range（0 始まり・UTF-16・end は含まない）
             frame?: { … } }                        ← .orbslog の frame 属性（doc 694 §4.1・evalSource など）
  result : { ok: boolean,                           ← diagnostics が空の時だけ true（#614 の evalMark と同じ）
             evalId: string,                        ← 🔴 サーバが振って返す（#987 と互換・^[A-Za-z0-9_-]{1,64}$）
             diagnostics: { kind: "parse" | "runtime", message: string }[],
             documentDirectory: string | null }     ← 実際に使った値
```

- 🔴 **`documentDirectory` は毎回必須で、「省略 = 前回値を保持」は無い**。凍結版の `//#documentDirectory` の 3 値（値あり = 設定 / 空 = クリア / 行を省略 = 前回値を保持・`repl-mode.ts:66-80,357-365`・#966）は、**stdio の REPL セッションが状態を持つことの副産物**である。層 2 は engine を in-process で呼ぶ（`InterpreterV2.execute` の `documentDirectory` 引数・§4.5.1）のでメタ行そのものが無くなり、状態を持つ理由が消える。凍結版の 3 値は**凍結版の wire の話として残す**（`//#documentDirectory` の行・下の表）。層 2 の中では `null` を `execute()` の空文字（基準のクリア・`interpreter-v2.ts:212-216`）へ写す
- **`evalId`** は `transport.step` の `source.evalId`（下）と対応する。MCP の評価にも振る（`source` が「文書の外」と分かるように）
- 🔴 **`target`（10-26 追加・裁定 3）**: 「どの文書のどの範囲の評価か」を運ぶ省略可能なフィールド。**省略してよい** — LLM がテキストだけを送る評価があるため。v1（段階 1・§4.5.1）で決めるのは**形と、v1 の層 2 がこれをどう使うか**まで:
  - **`code` が評価するテキストの正本のまま**（必須）。v1 の層 2 は `target.range` から区切りを決め直さない。区切りを `target` と同期済みの文書から決めるのは **#997 の段階 2**（台帳 P-01）
  - **`documentDirectory` は毎回必須のまま**で、層 2 は `target.uri` から基準を推測しない（§5.5 の規則と同じ。GUI の ⌘Enter はクライアントが自分の文書のディレクトリを渡し、MCP は IM.6 で決める）。`target.uri` と `documentDirectory` の一致も検査しない（基準を別に指す使い方を v1 で禁じる理由が無い）
  - `range` は `uri` の文書の中の位置で、`version` と一緒に送る（`range` があって `version` が無ければ `INVALID_PARAMS`）。`uri` の文書が `editor.didOpen` で同期されている必要は**無い**（MCP の `document_path` は開いていない文書を指しうる）
  - v1 の層 2 の使い道は 3 つ: (a) `evalId` ごとに `target` を覚え、`.orbslog` の frame の `sourceFile` に写す（旧計画 PR-L1b の `//#sourceFile` の代わり・計画 §4.1）(b) `transport.step` の `source` は v1 では**要求の `code` の座標**のまま（10-23 の決定）。文書の座標へ直すかは #997 / #987 で決める（`target` があれば層 2 が直せる材料は揃う）(c) `log.line` の `evalId` から、どの文書の評価かを GUI が引ける
  - **#997 で決めること（v1 では決めない）**: 区切りの単位（行・ブロック・意味）を `target` から決めるか / `code` と同期済みの文書の範囲の中身が違う時にどちらを正とするか / `@import` をまたぐ評価で `target` 以外の文書をどう扱うか / `target.range` がある時に `code` を省略できるようにするか（必須を省略可能に緩めるのは MINOR）
- 🔴 **評価の単位（区切り方）は v1 の wire に焼き込まない**。改訂（10-26）: 旧版の 2 択（「1 要求 = 1 パース」か「行ごと」か・#987 Q2・§14 (22)）は狭すぎた。区切り方は **#997 の評価のかたち**として別に設計する（§14.0）。**wire はどの区切り方でも同じ形**で受けられる（`target` があるので、層 2 が文書から区切りを決める形にも広げられる）。🔴 **段階 1 の実装は凍結版と同じ意味論**: 行を溜めてパースし、入力の終端（`EOF`）で終わった時だけ未完として溜め、空行 2 連と要求の終わりで強制実行し、要求 1 つを 1 バッチ（`AudioLine.beginBatchAll()` / `endBatchAll()`・#611 §5.7）にする（`repl-mode.ts:390-556`）。パリティ優先 — D-1 / D-2 の golden が動かないこと。凍結版との一致は §4.5.1 の差分テストが守る（段階 2 で「違いの記録」へ書き換える）
- 応答の `diagnostics` は凍結版の `{"evalMark":{…,diagnostics}}` と同じ中身。実行時エラーの前の文は実行済み（凍結版と同じ）

**MCP `evaluate_orbitscore({code, document_path?})` の写し（L2）**: 層 2 の MCP ハンドラが **IM.6 の順で `documentDirectory` を決めてから** `session.evaluate` を `source: "agent"` で呼ぶ。決め方は凍結版の純関数 `resolveEvaluateDocumentDirectory`（`evaluate-document-directory.ts:38-95`）をそのまま移し、入力を同期済みの editor 状態から作る: `document_path` → **アクティブな `.orbs`**（`editor.didChangeActive` の uri・`file:` のものだけ・§5.5）→ **ワークスペース**（`--workspace-root`・§4.5.2）→ `null`。🔴 **エラーは MCP の契約として写す**（文言は `tests/vscode-extension/evaluate-document-directory.spec.ts` が固定し、gated `#966` の 2 題名は応答の末尾 `(documentDirectory: …)` と import の失敗文言に依存する）: `document_path must not be empty` / `document_path "<p>" is relative but no workspace folder is open — pass an absolute path` / `could not inspect document_path "<abs>": <理由>` / `document_path "<abs>" is not an existing file`。🔴 改訂（10-26・裁定 1 の「引き継がない」）: **改行の制約は写さない** — `document_path must not contain a line break` と、アクティブな document / ワークスペースのパスが改行を含む時の 2 文言（`evaluate-document-directory.ts:57-59,78-81,87-90`）は、コード自身のコメントが言うとおり「基準が 1 行の `//#documentDirectory` メタ行で運ばれ、改行がそれを割る」ために生まれた（`:57`）。層 2 は基準を `session.evaluate` の引数で運ぶので理由が消えている。改行を含むパスも、存在するファイルなら通常どおり解決する。凍結版の単体テスト（`evaluate-document-directory.spec.ts`）の改行のケースは層 2 へ移さず、代わりに「改行を含む実在のパスが解決される」1 ケースを足す。これは MCP の v1 関門（§6.1）の**裁定による例外**として §6.1 の表に載せる。**`target` への写し**: `document_path` があれば `target: { uri: <絶対パスの file: URI> }`（範囲は無し）を付ける。無ければ `target` を付けない。応答テキストの末尾 **`(documentDirectory: <dir>|none)`** は `session.evaluate` の応答の `documentDirectory` から作る（凍結版の `evaluateToolResult`・`mcp-tools-engine.ts:15-29`）。

| 現行（メタ行 / stdout / MCP） | v1（向き） | 備考 | 漏れ |
|---|---|---|---|
| `//#evalMark` + コード送信 / `{"evalMark":{requestId,ok,diagnostics}}` | `session.evaluate` の要求と応答（C→S） | **request id が evalMark の役目を持つ**ので evalMark は消える（裁定 §3） | — |
| `//#evalBegin` / `//#evalEnd`（`repl-mode.ts:108-115`・#611 §5.7・O-surface） | **無し**（`session.evaluate` の 1 要求が 1 バッチ） | 凍結版で 1 評価を括る理由（chunk 境界で評価が割れる・カーソル規則の自己修復）は WebSocket の 1 フレーム = 1 メッセージ（§5.2）で構造的に消える。バッチの意味論（`beginBatchAll` / `endBatchAll`）は層 2 の中で要求ごとに保つ | — |
| `//#documentDirectory`（3 値）+ `global.setDocumentDirectory(...)` の DSL 注入（`engine-process.ts:647-702`） | `session.evaluate` の `documentDirectory`（必須・`string \| null`） | 帯域外の注入も DSL の注入も要らない（`execute()` が自分で設定する）。import の基準（IM.6）は params で確定 | **L3** |
| `evaluate_orbitscore({code, document_path?})` | 層 2 の MCP ハンドラ → IM.6 の解決 → `session.evaluate`（`source:"agent"`） | 上の段落 | **L2** |
| stdout `✓`（文ごとの成功） | **写さない**（応答の `ok` に吸収） | 凍結版でも `get_log` には出ない（`shouldFilterLine` が落とす・`engine-handlers.ts:140`） | — |

#### 5.3.2 engine・audio

| 現行 | v1（向き） | 備考 | 漏れ |
|---|---|---|---|
| `start_engine({capture_wav?, debug?})` / 引数 `repl [--audio-device X] [--debug]` / env `ORBIT_CAPTURE_WAV` `ORBITSCORE_DEBUG` `ORBIT_HOST_BUNDLE_ID`（`engine-process.ts:346-377`） | `engine.start({captureWav?, audioDevice?, debug?, hostBundleId?})`（C→S） | 🔴 **`hostBundleId` を足した**（#940: プラグイン窓がホストの前面化に追従する追従先）。省略時は session の起動引数 `--host-bundle-id` の値（アプリ自身の bundle id・§4.5）を使う — MCP の `start_engine` には無い引数なので、LLM が起動した engine も同じ値になる。中身は既存 `startEngineForAgent` 等を移す | **L9** |
| `stop_engine` / `orbitscore.stopEngine` | `engine.stop()`（C→S） | 🔴 **応答は daemon の終了（プロセスの消滅）を待ってから返す**（下の `restartEngine` の合成が成り立つための契約）。現行の停止経路（`cli/shutdown.ts`・`DaemonClient` の `quit()`）がプロセスの消滅まで待っているかは**未確認**（本改訂では読んでいない）。待っていなければ S-rpc で層 2 の側に待ちを足す | — |
| `//#getEngineState` / `get_engine_state` / `{"engineState":…}` | `engine.getState()`（C→S） | | — |
| `//#selectAudioDevice` / `select_audio_device` / `{"selectAudioDevice":…}` / `engineViewSelectDevice` | `audio.selectDevice({device})`（C→S） | 凍結版で唯一 requestId を持たない FIFO（`device-switch` bridge）。v1 では request id で相関する | — |
| `list_audio_devices` | `audio.listDevices()`（C→S） | | — |
| `analyze_audio` | `audio.analyze({wavPath, windowMs, perChannel})`（C→S） | `wav-analysis.ts`（pure）を層 2 へ | — |

#### 5.3.3 plugin

| 現行 | v1（向き） | 備考 | 漏れ |
|---|---|---|---|
| `//#savePluginState` / `save_plugin_state` / `{"savePluginState":…}` | `plugin.saveState({receiver,index})`（C→S） | 🔴 4.4.0 で**ファイルの形式が変わった**（wire は不変）: VST3 の state は Steinberg 標準の `.vstpreset`（`Comp` + `Cont`）で保存し、復元時に class ID を照合して別プラグインのファイルはエラーにする。4.3.0 以前の raw state も読める（#982 / #989・`orbit-vst3-preset`）。層 1 の振る舞いなので層 2 は応答を素通しする | **L4** |
| `//#pluginUi` / `open_plugin_ui` / `close_plugin_ui` / `{"pluginUi":…}` | `plugin.openUi({receiver,index,expectedName?})` / `plugin.closeUi({receiver,index})`（C→S） | ウィンドウは child プロセスが所有（UIH spec）。アプリは開閉を**要求するだけ** | — |
| `open_plugin_ui_at_cursor` / `orbitscore.openPluginUiAtCursor`（#939・4.2.0） | `plugin.openUiAtCursor()`（C→S）— 層 2 が同期済みの選択位置（§5.5）から**カーソル下のプラグイン名を解決**し、`plugin.openUi({receiver,index})` を呼ぶ | 解決規則（DSL 語彙を receiver に誤解決しない・#940 の `96fdc56d`）は**層 2 に置く**（GUI と MCP で同じ結果 = D-4）。エディタが付いていなければ `NO_EDITOR_ATTACHED` | — |
| `list_plugins` / `rescan_plugins` / `orbitscore.rescanPlugins` | `plugin.list()` / `plugin.rescan()`（C→S） | `plugin-catalog-reader.ts`（pure）を層 2 へ | — |
| `orbitscore.browsePlugins`（カタログを QuickPick に出し、選んだ名前をエディタへ挿入・`plugin-commands.ts:35-…`） | **`plugin.list()` に写す**（新メソッドなし） | アプリでは Catalog パネルが `plugin.list` を描き、挿入は Monaco の中のテキスト編集（GUI の操作は DSL テキストに落ちる・§7.2） | **L8** |

#### 5.3.4 editor（document 同期・逆方向・言語サービス）

| 現行 | v1（向き） | 備考 | 漏れ |
|---|---|---|---|
| `get_diagnostics` | `editor.getDiagnostics({uri})`（C→S。**計算は層 2**） | 層 2 が同期済み document から計算（§5.5） | — |
| 補完（`registerCompletionItemProvider` 3 箇所） | `editor.complete({uri, position})`（C→S） | `completion-context.ts` の vscode 依存を外して層 2 へ。Monaco の `CompletionItemProvider` は結果を描くだけ | — |
| `get_editor_state` / `get_document_text` | **層 2 の同期済みの写しから答える**（逆方向リクエストは要らない・§5.4） | エディタが付いていなければ `NO_EDITOR_ATTACHED` | — |
| `open_file` / `set_selection` / `run_selection` / `edit_replace` / `save_file` / `configure_flash`（+ `orbitscore.configureFlash`・設定 `flash*`） | **`editor.*` の逆方向**（S→C）: `editor.openFile` / `editor.setSelection` / `editor.runSelection` / `editor.editReplace` / `editor.saveFile` / `editor.configureFlash` | 層 2 が `editor` capability を持つクライアントへ**リクエストを送る**。無ければ `NO_EDITOR_ATTACHED`（D-3） | — |

#### 5.3.5 docs（L1）

```
docs.get    (C→S) params { site: "user" | "dev", path: string }
                   result { text: string } | error DOC_NOT_FOUND | error DOCS_UNAVAILABLE
docs.search (C→S) params { site: "user" | "dev", query: string, limit?: number }   ← 既定 10
                   result { matches: { path, line, excerpt }[] } | error DOCS_UNAVAILABLE
```

| 現行 | v1 | 備考 | 漏れ |
|---|---|---|---|
| `get_dev_doc` / `search_dev_docs` | `docs.get` / `docs.search`（`site:"dev"`） | 🔴 **dev が無い時の契約**: dev サイトは `.app` に同梱しない（owner 決定 2026-09-18・D-9）。`--docs-dir` に dev の在りかが無い時は、**すべての呼び出しが `DOCS_UNAVAILABLE`**（文言は凍結版の `DEV_DOCS_UNAVAILABLE_MESSAGE`・`mcp-docs.ts:46-48` と同じ: モノレポのチェックアウトでだけ読める + 公開 URL）を返す — 「見つからない」と区別する（`mcp-tools-editor.ts:219-252`） | **L1** |
| `get_user_doc` / `search_user_docs`（#954・4.2.1） | `docs.get` / `docs.search`（`site:"user"`） | user サイトは同梱される（D-9）ので「無い」は壊れたインストールだけ（凍結版も unavailable の分岐を持たない・`mcp-tools-editor.ts:309-330`） | **L1** |
| `search_*` の `limit` | `docs.search` の `limit?` | 既定 **10**。数でなければ 10・小数は切り捨て・負は 0（`parseSearchLimit`・`mcp-tools-editor.ts:213-216`） | **L1** |
| docs の在りか（`__dirname` 決め打ち・`mcp-server.ts:151-154`） | 起動引数 `--docs-dir`（複数可・先勝ち・計画 N-3） | 同梱の中身は別冊 §6 | — |

#### 5.3.6 イベントとログ（stdout 4 系統 + stderr）

```
transport.step (S→C 通知・全クライアントへ broadcast)
  { seq: string, argPath: string, atEpochMs: number,
    source?: { evalId: string,
               start: { line: number, character: number },
               end:   { line: number, character: number } } | null }   ← 🔴 10-23 追加（省略可能・省略 ≡ null）
log.line (S→C 通知 + ring)
  { level: "error" | "warn" | "info" | "debug",
    kind: "diagnostic" | "engine" | "daemon" | "stall" | "session",
    text: string, ts: number, clientId?: string, evalId?: string }   ← 🔴 10-23 で level / kind を定義
```

- 🔴 **`transport.step` の `source` を最初から入れる**（#987 の抽象モデル `StepEvent`・987 §5.1 と同じ形）。座標は **0 始まり・UTF-16**（LSP と同じ）で、`evalId` の要求の `code` の中の位置（end は含まない）。Monaco（1 始まり）はクライアントで +1。行ごとに評価する既定（§5.3.1）でも、層 2 がバッファの開始行を足して**要求の `code` の座標**に直して載せる。`null` = 文書の外（MCP の評価・`import` したファイル・ID の無い評価）。入れないと WebView が文字列検索の playhead を先に作り、後で剥がすことになる。🔴 **v1 の実装で `source` を埋めるのは、engine がパーサの位置を持ってから**（#987 B′ §6）。それまでは `null` を送り、WebView は `playhead.ts` を暫定の消費者にする（§1.3 の暫定の条件・台帳 **P-04**・期限は第 1 リリース）。改訂（10-26）: 位置の情報は #997 の評価のかたちが扱う（#997 の「決めること」に #987 が入っている）ので、`source` を埋める作業は **S-eval** に置く。`session.evaluate` の `target`（§5.3.1）があれば、層 2 は `source` を文書の座標へ直す材料も持つ
- 🔴 **`log.line` の分類は層 2 が行い、クライアントは分類しない**。`kind` の意味: `diagnostic` = パース / 実行時エラー（凍結版の stderr `[ERROR] …`）/ `engine` = **stdout の人間向けログ行**（4 系統目・L11）/ `daemon` = daemon の stderr 由来の行 / `stall` = 評価の待ち行列の滞留報告（#607）/ `session` = 層 2 自身の行（MCP セッションの開閉など）。`level` は: `diagnostic` と `stall` は `error`。`daemon` は凍結版の `isDaemonNonErrorTracingLine`（`daemon-stderr-lines.ts:21-45`）の規則で `TRACE|DEBUG|INFO|WARN` を名乗る tracing 行をその level に、**読めない行（panic・生 print）は `error`**（fail-loud・WARN を非エラーに置くのは owner 判断 2026-08-28）。`engine` は凍結版の `shouldFilterLine`（`engine-handlers.ts:43-155`）が「出す」行を `info`（`⚠️` を含む行は `warn`）、「捨てる」行を `debug` にする
- `get_log`（`session.getLog({lines})`）が返す ring は**凍結版と同じ規則で同じ文字列**にする: debug でない時は `level` が `debug` の行を ring に入れず、debug の時は全部入れる（凍結版の「非 debug はフィルタ・debug は生の stream」・`engine-handlers.ts:318-327`）。stderr 由来の行は凍結版と同じく `ERROR: ` を前置した文字列で ring に積む（`createLinePrefixer`・`engine-handlers.ts:387-426`）。gated の ERROR 件数の比較（`<=`）がそのまま効くようにするため。🔴 **debug の時は `transport.step` も凍結版と同じ文字列 `[STEP] <seq> <argPath> <atEpochMs>` で ring に積む** — gated の `steps the live playhead through an instrument() sequence` は debug で起動した engine の `get_log` からこの行を読む（`orbitstudio-mcp-gated.spec.ts:3233-3313`。凍結版の debug は stdout の生の stream を ring に流すので `[STEP]` が載る）。`source` は行に足さない（凍結版の文法を保つ）。改訂（10-26）: ring の文字列を凍結版に揃えるのは **`get_log` の戻りが MCP の v1 関門に入る**から（§6.1）で、ログの文言そのものは裁定 1 で「参照」である。v1 の後は変えてよい（台帳 P-03）

| 現行（stdout / stderr / push） | v1 | 備考 | 漏れ |
|---|---|---|---|
| stdout `[STEP] seq argPath atEpochMs`（`rust-engine-player.ts:1656`・`midi-scheduler.ts:174`） | 通知 `transport.step`（S→C） | 全クライアントへ broadcast | — |
| stdout 1 行 JSON 5 種（`evalMark` `savePluginState` `pluginUi` `engineState` `selectAudioDevice`） | 各メソッドの**応答**（request id で相関） | ブリッジ（凍結版 6 ファイル 576 行）は不要 | — |
| 🔴 stdout の**人間向けログ行**（`🎚️ <seq>: play=… (next cycle)` / `⚠️` / `🎛️` / `▶` / `⏹` / `🔄` / `✅ Global running` ほか・`engine-handlers.ts:43-155` の部分文字列フィルタ） | 通知 `log.line({kind:"engine"})` + ring | 「出す / 捨てる」の規則は**意味論として層 2 に写す**（`level` の決め方は上）。#964 の退行（`"type"` を含む `🎚️` 行が落ちた）を繰り返さないよう、凍結版の単体テストの事例を層 2 でも回す | **L11** |
| stderr `[ERROR] …`（パース / 実行時）/ `outputChannel.appendLine` | 通知 `log.line({kind:"diagnostic", level:"error"})` + ring + `session.evaluate` の `diagnostics` | stderr は ERROR に分類（memory `stderr-is-classified-as-error`）を**層 2 の中で**行う | — |
| daemon の stderr（engine が `[daemon] …` を前置して転送・`daemon-client.ts:870-873`） | 通知 `log.line({kind:"daemon"})` + ring | `level` は `isDaemonNonErrorTracingLine` の規則 | — |
| `[ERROR] REPL queue is still blocked …`（#607・`repl-mode.ts:553-576`） | 通知 `log.line({kind:"stall", level:"error"})` + ring | 打ち切らずに報告する意味論は同じ | — |
| `{"engineState":…}` の push・status bar・`PluginUiClosed` 等の daemon event | 通知 `engine.state({…})` / `plugin.uiClosed({…})` / `transport.state({playing, tempo?})` | status bar の「Playing / Ready」は `transport.state` を描くだけ（#527 の取り違えクラスは引数付き 1 本に畳んで潰す） | — |
| `get_log` | `session.getLog({lines})`（C→S） | `log-ring.ts`（pure）を層 2 へ。GUI のログパネルも同じ ring を読む | — |
| `register_mcp_server` / `orbitscore.registerMcpServer` | `session.registerMcp({scope})`（C→S） | `mcp-registration.ts`（pure）を層 2 へ。🔴 改訂（10-26・裁定 4）: 書くのは**中継のスタブの stdio 登録**で、**秘密もポートも書かない**（§6.3）。MCP の `port` 引数は受け取るが使わない（v1 関門の例外・§6.1） | — |

#### 5.3.7 コマンド 19（contributes 16 + 登録のみ 3）

| コマンド | v1 / アプリでの置き場 | 備考 | 漏れ |
|---|---|---|---|
| `toggleEngine` / `engineViewToggleEngine`（登録のみ） | `engine.getState` を見て GUI が `engine.start` / `engine.stop` を選ぶ（新メソッドなし）。Engine パネルのボタン + メニュー | §7.4 | **L7**（後者） |
| `stopEngine` | `engine.stop()` | | — |
| `restartEngine` | 🔴 **`engine.stop` + `engine.start` の合成**（新メソッドは作らない） | 凍結版は `stopEngine()` → **2,200 ms の sleep** → `startEngine()`（`extension.ts:315-324`）で、終了を待つ代わりに時間で待っていた。層 2 は `engine.stop` の応答を daemon の終了まで遅らせる（§5.3.2）ので sleep は要らない。凍結版の前置き（出力デバイスが選ばれていなければ案内して止める・`:317-320`）は GUI 側の表示 | **L8** |
| `startEngineDebug` | `engine.start({debug:true})` | 表面は §14 (11)（推奨: 環境設定のトグル） | — |
| `engineViewToggleDebug`（登録のみ） | 環境設定のトグル（設定 `engineDebug` と同じ）→ 次の `engine.start({debug})` | 新メソッドなし | **L7** |
| `runSelection`（⌘Enter・唯一のキーバインド） | Monaco の keybinding → 評価（§7.4）。MCP の `run_selection` は `editor.runSelection` | subject-block は層 2 | — |
| `configureFlash` | `editor.configureFlash` + 環境設定 | §5.3.4 | — |
| `registerMcpServer` | `session.registerMcp`（アプリのメニュー「Claude Code / Codex に登録」・§6.3） | §5.3.6・§6.3 | — |
| `rescanPlugins` / `browsePlugins` | `plugin.rescan()` / `plugin.list()` | §5.3.3 | **L8**（後者） |
| `openPluginUiAtCursor` | `plugin.openUiAtCursor()` | §5.3.3 | — |
| `engineViewSelectDevice` | `audio.selectDevice` | §5.3.2 | — |
| `openDocs` | 層 3: Docs パネル（`/app/` と別の WKWebView・§4.7）で `/orbitscore/`（user）を開く。RPC なし（静的配信） | 凍結版は既定のブラウザで開く（`docs-panels.ts:43-57`） | **L8** |
| `openDevDocs` / `openDevDocsPanel` | 層 3: Docs パネルで `/orbitscore/dev/`。`.app` では dev を同梱しないので `DOCS_UNAVAILABLE` と同じ案内を出す | §5.3.5 | **L8** |
| `openWalkthrough` / `reloadWindow` | **写さない**（VS Code 固有）— §14 (11) | 推奨: 落とす | — |
| `showCommands`（登録のみ・ステータスバーの click → コマンドの QuickPick・`extension.ts:126,153`） | **写さない**（VS Code の UI。アプリではメニューバーが同じ役目）— §14 (11) に追加 | 推奨: 落とす | **L7** |

#### 5.3.8 HTTP 4 経路（同じリスナー・L5）

| 現行（`mcp-server.ts:192-307`） | v1 | 備考 | 漏れ |
|---|---|---|---|
| `POST/GET/DELETE /mcp`（Streamable HTTP・Host 検証のみ） | 🔴 改訂（10-26）: **TCP には置かない**（`POST /mcp` → 404）。能力（LLM が MCP で繋ぐ）は**中継**（stdio・§6）が持つ | 10-23 の「同じ形 + トークン + Origin」は裁定 4 で置き換えた（§4.7）。HTTP しか話せない MCP クライアントが現れたら、中継に `--http <port>` を MINOR で足す（その時は仕様の MUST の Origin + トークン + 固定ポート・再検討 5.1） | — |
| `GET /orbitscore/**`（user サイトの dist・無ければ 503 + ビルドの案内・`isDocsDistStale` で base 違いも 503） | 同じ経路・同じ応答。中身は `--docs-dir` の user（`.app` では `Contents/Resources/docs/user-site`・別冊 §6.2） | トークン不要・Host 検証あり（§4.7 の docs の判断） | **L5** |
| `GET /orbitscore/dev/**`（dev サイト・無ければ 503 + `DEV_DOCS_UNAVAILABLE_MESSAGE`） | 同じ経路・同じ応答（`.app` では常に 503 + 案内） | 最長一致で dev を先に見る（`:212-229`） | **L5** |
| `GET /docs` → 302 `/orbitscore/dev/` | 同じ | パリティのため据え置く | **L5** |
| （無し） | 🆕 `GET /app/**`（WebView の bundle）・`/rpc`（WebSocket） | §7.3・§5.2 | — |

#### 5.3.9 環境変数と起動引数（L9・L10）

| 現行 | v1 | 備考 | 漏れ |
|---|---|---|---|
| `ORBITSCORE_MCP_PORT`（拡張が読む・`extension.ts:237`） | 🔴 改訂（10-26）: **写さない**（TCP の `/mcp` が無い。LLM は中継から入る）。ハーネスの注入点は `ORBITSTUDIO_RUNTIME_DIR`（下）に替わる | 拡張版の設定 `mcpServer.port` も同じく引き継がない（通信方式から来た表面・裁定 1） | — |
| `ORBITSCORE_DEBUG` / `ORBIT_CAPTURE_WAV` / `ORBIT_HOST_BUNDLE_ID`（拡張 → engine の env） | `engine.start({debug, captureWav, hostBundleId})` の値から、層 2 が engine / daemon の env を組む | 層 1 が読む env は変えない（裁定 2.4） | **L9** |
| 引数 `repl --audio-device <name> --debug` | `engine.start({audioDevice, debug})` | | **L9** |
| `ORBIT_PLUGIN_CATALOG`（`plugin-catalog.ts:40`・`plugin-catalog-reader.ts:117`）/ `ORBIT_PLUGIN_SCAN_PATH`（`plugin-catalog-reader.ts:184`） | session の起動引数 `--plugin-catalog` / `--plugin-scan-path`（優先順: 起動引数 → env → 既定・§4.5） | テストの注入点を失わない | **L10** |
| `ORBIT_AUDIO_DAEMON_PATH`（`daemon-client.ts:185`） | env のまま（アプリが同梱の daemon を指す・§9.1） | | — |
| `ORBITSCORE_SESSION_LOG`（`session-log-gate.ts:12-14`・`.orbslog` の opt-in） | env のまま（`.orbslog` を有効にする口は PR-L1b の付け替え・計画 §4.1） | | — |
| `ELECTRON_RUN_AS_NODE` / `ELECTRON_NO_ASAR`（spawn 時・`engine-process.ts:415`） | **写さない**（Electron が無い。同梱 node・§9.1・§14 (3)） | | — |
| （無し） | 🆕 `ORBITSTUDIO_RUNTIME_DIR`（アプリと中継が読む。アプリは session の `--runtime-dir` へそのまま写す）。改訂（10-26）: 10-23 の `ORBITSCORE_SESSION_TOKEN_FILE` は削った | ハーネスが利用者の動いているアプリに触れずに分離する経路（§10.2） | — |
| （無し） | 🆕 session の起動引数 `--runtime-dir` / `--port` / `--token-file` / `--workspace-root` / `--parent-pid` / `--host-bundle-id` / `--docs-dir` / `--web-dir`（`/app/` で配る WebView の bundle）。改訂（10-26）: `--mcp` は削った | §4.4・§4.5・§4.5.2・§4.7・§7.3 | — |
| （無し） | 🆕 中継の入口 `orbitscore relay [--runtime-dir <dir>]`（§6.2） | LLM クライアントが stdio で起動する | — |

### 5.4 エディタ逆方向の契約（P-B を採る決め手）

- `editor` capability を宣言したクライアントは、attach 時に**開いている document を同期**する（§5.5）。層 2 は「今どの document が開いていて、選択がどこか」を**クライアントに聞かずに知っている**（`editor.getState` は同期済みの写しを返す）
- `editor.runSelection` は**クライアントが選択テキストと位置を返すだけ**で、subject-block の解決（`run-selection.ts:27` の `getLineSubject` と複数行検出）は**層 2 が行う**（§12 補正）。したがって VS Code 版とアプリ版で「⌘Enter で何が評価されるか」がずれない
- `editor` クライアントは**同時に 1 つまで**（2 つ目の attach は `EDITOR_ALREADY_ATTACHED`）。複数エディタの需要は §14 (8)。🔴 改訂（10-26・§14.0 (8)）: **1 つの editor クライアントは複数の document を持てる**（ウィンドウやタブを複数開くのは 1 クライアントの中の話。§5.5 の `didOpen` は uri ごと）。「1 つまで」は接続の数であって document の数ではない
- 逆方向リクエストにもタイムアウトを置く（現行 bridge の timeout と同じ役割）。期限切れは `EDITOR_TIMEOUT` として MCP 呼び出し元へそのまま返す（黙らない）

### 5.5 document 同期（LSP の形だけ借りる）

`editor.didOpen({uri, text, documentDirectory})` / `editor.didChange({uri, version, changes[]})` / `editor.didClose({uri})` / `editor.didChangeSelection({uri, range})` / 改訂（10-23）`editor.didChangeActive({uri: string | null})`（C→S・通知）。層 2 は document の写しを持ち、診断（`diagnostics-analysis.ts` + `plugin-name-diagnostics.ts`）を計算して `editor.diagnostics({uri, items[]})` を push する。**`get_diagnostics`（MCP）と Monaco のマーカーは同じ計算結果**を見る。

- `editor.didChangeActive` は**前面のウィンドウの document**（キーウィンドウ。Monaco にフォーカスが無くても同じ）を伝え、document の窓が 1 つも無ければ `null`。MCP `evaluate_orbitscore` の IM.6 の第 2 候補（アクティブな `.orbs`・`file:` の uri だけ）と `get_editor_state` はこの値を読む（§5.3.1）。凍結版の `vscode.window.activeTextEditor` に当たる
- `didOpen` の `documentDirectory` は document の所在の記録で、**評価の基準ではない**。評価の基準は `session.evaluate` の `documentDirectory`（毎回必須・§5.3.1）が唯一の入口で、層 2 は document の写しから基準を推測しない（GUI の ⌘Enter はクライアントが自分の document のディレクトリを渡す）。改訂（10-26）: `session.evaluate` に `target`（どの文書のどの範囲か）が付いても、**この規則は変えない** — `target` は評価の帰属（どの文書の評価か）を運び、基準は運ばない。区切りを文書の写しから決めることは #997 の段階 2 で入りうるが、それは「何を評価するか」の話で、「どこを基準に import を解決するか」とは別の入口のまま保つ
- F-12 で層 2 を再起動した時は、開いている全 document の `didOpen` と `didChangeActive` を再送する（§12）

### 5.6 同時性（§12 追加の未検証項目・本書の答え）

| 規則 | 内容 | 理由 |
|---|---|---|
| **評価は FIFO・1 本** | すべてのクライアントからの `session.evaluate` は到着順に 1 本のキューへ入り、1 件ずつ処理される（1 件の中の評価の単位は §5.3.1 — 既定は凍結版と同じ行ごと）。ロックも所有権も無い | Node の単一イベントループが今日も同じ直列性を与えている（`repl-mode.ts` の FIFO・`//#evalMark` のコメント）。プロセス境界で失われるのは「同じプロセスにいる暗黙の直列性」であって、**キューを 1 本に固定すれば復元できる** |
| **後勝ち** | 同じシーケンスへ人間と LLM が続けて評価すれば、後の評価が勝つ。DSL のライブ後勝ち（SC.10）と同じ | 人間が 2 回評価した時と区別しない = 新しい意味論を作らない |
| **出自を記録** | `session.evaluate` は `source`（human / agent）と `clientId` を持ち、`.orbslog` の frame 属性（doc 694 §4.1 の `evalSource`）に写す。`log.line` にも出自を付けて全クライアントへ broadcast | 「誰の評価で音が変わったか」が後から追える。GUI のログに LLM の評価が見える |
| **エディタは 1 つ** | §5.4 | 「どのエディタに `open_file` するか」の問いを第 1 リリースでは持たない |

### 5.7 現行表面との対応が**全射**であることの確認（10-23 改訂: 列挙の手段と基準タグを直した）

§5.3 の表は、基準タグ（`PARITY_BASELINE_TAG` = v4.4.0）の現行表面を**次の手段で列挙して 1 行ずつ写した**。**漏れの証明は列挙表そのもの**（memory `absence-claims-need-exhaustive-enumeration`）。

| 母集団 | 件数（v4.4.0） | 列挙の正本 | 🔴 使ってはいけない手段 |
|---|---|---|---|
| MCP ツール | **28**（無条件 23 + handler があるときだけ登録する 5） | **実行時の `tools/list`**（またはそれを固定している `tests/vscode-extension/mcp-server.spec.ts:396-480` — 無条件 23 本の順序と、全 handler で 28 本） | `registerTool(` の字面を grep してツール名を拾う手段は**今 24 しか出さない**（docs 系 4 本が `registerDocGetTool` / `registerDocSearchTool` の `name` 変数経由・`mcp-tools-editor.ts:284-330`）。旧版の「26 個」はこの手段で数えた |
| `//#` メタ行 | **8**（`documentDirectory` / `evalBegin` / `evalEnd` / `evalMark` / `getEngineState` / `pluginUi` / `savePluginState` / `selectAudioDevice`） | `git grep -ohE "//#[a-zA-Z]+" <tag> -- packages/vscode-extension/src packages/engine/src \| sort -u` | — |
| stdout | **4 系統**（`✓` / `[STEP]` / 1 行 JSON 5 種 / 人間向けのログ行）+ stderr `[ERROR]` | `engine-handlers.ts:43-155`（`shouldFilterLine`）と `git grep -nE "\[STEP\]\|console.log\(JSON.stringify" <tag> -- packages/engine/src` | 旧版の「3 系統」は人間向けのログ行を数えていなかった |
| コマンド | **19**（`contributes.commands` 16 + 登録のみ 3） | `package.json` の `contributes` と `git grep -n "registerCommand(" <tag> -- packages/vscode-extension/src` の**和集合** | `contributes` だけを数える手段（旧版の 16）は、ステータスバーやビューの click だけで使う 3 本を落とす |
| HTTP 経路 | **4**（`/mcp` / `/orbitscore/**` / `/orbitscore/dev/**` / `/docs`） | `mcp-server.ts:192-307`（`handleHttp`） | — |
| 環境変数 | 拡張・engine のコードが読むか子へ渡す 9（`ORBITSCORE_MCP_PORT` `ORBITSCORE_DEBUG` `ORBITSCORE_SESSION_LOG` `ORBIT_CAPTURE_WAV` `ORBIT_HOST_BUNDLE_ID` `ORBIT_AUDIO_DAEMON_PATH` `ORBIT_PLUGIN_CATALOG` `ORBIT_PLUGIN_SCAN_PATH` + テスト用の `VITEST`）+ spawn 時の `ELECTRON_*` 2 | `git grep -h -o -E "process\.env\.[A-Z_0-9]+\|env\.[A-Z][A-Z_0-9]+" <tag> -- packages/vscode-extension/src packages/engine/src \| sort -u` | — |

`✓` は `session.evaluate` の応答の `ok` に吸収され、`evalBegin` / `evalEnd` は要求 1 つ = 1 バッチに吸収されて、対応するメソッドを持たない（§5.3.1 の表にはその旨の行がある）。`VITEST` はテストの判定だけに使う変数で、写さない。

🔴 **旧版の「列挙は凍結タグ（4.2.0）で固定 — 凍結版は以後 bug fix しか入らない」を改めた**。凍結版にも owner の個別例外で表面が入った（4.3.0 = DSL・4.4.0 = MCP の引数と VST3 の state の形式・§0 2.5）。したがって:

- **列挙と台帳の基準タグは 1 か所から読む**: `tests/e2e/native-parity-ledger.ts` の `PARITY_BASELINE_TAG`（§1.2 D-1）。本節の件数・§5.3 の表・台帳の母集団はすべてこの値の時点のもの
- 凍結版に例外が入るたびに、**その PR で `PARITY_BASELINE_TAG` を進め、上の手段で列挙し直し、増えた表面に §5.3 の行を足す**（台帳の未分類 red が題名の分類を強制する。§5.3 の表の追従は PR の完了条件として本書に書く — 本書を検査する機械は無い）
- 新ラインが RPC メソッドを足す時は、本表の母集団は変わらない（§5.3 に v1 の行が増えるだけ）

### 5.8 スキーマと生成（単一の真実）

- 置き場: `protocol/session/v1/`（§8）。形式は **JSON Schema 2020-12**。理由: TS（`json-schema-to-typescript`）・Swift（`quicktype`）・Rust（`typify` / `schemars` の逆）へ**言語をまたいで**生成できる形式はこれしか無い。TypeScript や zod を正本にすると Swift 側は手書きになる
- 生成物は**コミットする**（`protocol/gen/ts/` `protocol/gen/swift/`）。CI は「生成し直して差分ゼロ」を検査する（`npm run protocol:check`）。理由: Xcode / SwiftPM のビルドに Node を要求しない
- 🔴 **ツールの選定は N0-b の spike で確定**（本書は候補を挙げるだけ・未検証）。spike の受け入れ: 3 メッセージ（`session.evaluate` 要求 / 応答 / `transport.step`）が TS ↔ Swift で往復して等しい
- `surfaces` 拡張キー: 各メソッドに `"x-surfaces": ["gui","mcp"]` を必須にし、D-4 の検査が読む
- 🔴 **ライセンス（10-26・§14.0 (9)）**: `protocol/` の**定義**（`session/v1/*.schema.json` と生成物 `gen/`）だけを **Apache-2.0** にする。`protocol/LICENSE` を S-rpc の小 PR（N1-a1・スキーマを置く PR）で足す。リポジトリのルートのライセンス（Signal compose Source-Available License v1.0）はそれ以外にかかったまま。理由: 第三者が自分のクライアント（別のエディタ・コントローラ・可視化ツール）を作る時に定義を使えるようにする（裁定 6 の「公開したプロトコルに繋ぐ一般の窓口」の前提）。定義が公開されて使われ始めた後に変えると使った人に影響するので、**スキーマを置く PR と同じ PR で**入れる。owner の意見（原文）「そういう意味ではDSLもApache-2.0でいいと思います。」は**記録だけ**で、本書の他のライセンスの記述は変えない（範囲は §14.0 の第 2 回の記録・#998）

### 5.9 スキーマを書いた時に補ったもの（2026-10-26・S-rpc の N1-a1〔#1001〕・🔴 owner の確認待ち）

`protocol/session/v1/session.schema.json` を書いた時に、本書だけでは形が決まらなかった所を次のように補った。**束 S-rpc の締めで owner が確かめるまで確定ではない**（消費者がテストだけのうちに直せる・一方通行 N-1）。

| # | 本書の記述 | 補ったもの | 理由 |
|---|---|---|---|
| S-1 | §5.8「`x-surfaces: ["gui","mcp"]` を必須に」/ D-4「GUI が呼ぶメソッド ⊆ MCP が呼ぶメソッド」 | 語彙を 4 つにした: `gui`（GUI の操作）/ `mcp`（中継がツールの実装に呼ぶ）/ `editor`（エディタのクライアントが文書の写しを保つための同期と、エディタに描く言語サービス = `editor.did*`・`editor.complete`）/ `infra`（握手・寿命・イベント）。D-4 は `gui` ⇒ `mcp` だけを検査する。あわせて `x-mcp-tools`（そのメソッドを使う MCP ツール）を足し、28 本と対応することを検査する | D-4 を字面どおりに読むと、文書の同期（§5.5）と補完（§5.3.4）が「GUI だけの経路」になる。どちらも操作ではない（同期は写しを保つため・補完は描画）。補完を MCP のツールにすると v1 関門（§6.1・28 本）を破る |
| S-2 | §5.2「不一致は attach を拒否する（strict）」/ §6.2 RL-5「同じ MAJOR なら繋ぐ（MINOR は追加だけ）」 | `session.attach` の params に `protocol_version` を足し、**MAJOR が違う時だけ** `PROTOCOL_VERSION_MISMATCH` で拒否する。MINOR の違いは繋ぐ（知らないメソッドは `METHOD_NOT_FOUND` で黙らずに返る） | §5.2 の params にクライアントの版が無く、サーバが拒否できない。§5.2 と RL-5 は MINOR の扱いが食い違っていたので RL-5 に合わせた（自動更新の後の古い中継が MINOR 違いで締め出されない） |
| S-3 | §5.5 `editor.didOpen({uri, text, documentDirectory})` | `version` を足した（LSP の `TextDocumentItem` と同じ） | §5.3.1 の `target.version` は「`editor.didChange` の version」で、最初の版が `didOpen` に無いと数え始められない |
| S-4 | §5.5 `editor.didChangeSelection({uri, range})` | 省略可能な `cursor`（選択の動く側。省略時は `range.end`） | `get_editor_state` は `cursor` と `selection` を別に返す。範囲を正規化すると、後ろ向きの選択でカーソルの位置が失われる |
| S-5 | §5.3.4 逆方向 `editor.*`（S→C） | 中継から届くのは C→S の同名のメソッドで、層 2 がエディタのクライアントへ転送する（スキーマの `x-editor-request`）。`editor.runSelection` だけは往復の中身が違う — エディタは選択の位置（`SelectionSnapshot`）だけを返し、層 2 が subject-block を解決して評価する（§5.4） | §5.3.4 は S→C の側しか書いておらず、中継（クライアント）がどのメソッドで頼むかが無かった |
| S-6 | §5.3.6 の通知 `plugin.uiClosed` | v1 のスキーマに**まだ入れていない**（MINOR で足す） | daemon の `PluginUiClosed` は engine の中で処理され（`rust-engine-player.ts:655`）、層 2 が受け取る口が無い。台帳 P-07（型付きの出力の口・S-eval）で一緒に足すのを提案する |
| S-7 | 構造化エラー（`NO_EDITOR_ATTACHED` ほか）の数値 | `x-errors` に数値を置いた（JSON-RPC のサーバ範囲 −32000〜−32099）。エラーの `data.code` に名前を入れる | 本書は名前だけだった |
| S-8（N1-a2） | engine が起動していない時の `session.evaluate`（§5.3.1 に記述なし） | エラー `ENGINE_NOT_RUNNING`（−32031・文言は凍結版と同じ「engine is not running — start the engine first」）。評価しない | `InterpreterV2.execute` は起動していなければ自分で daemon を起こす（`ensureBooted`・`interpreter-v2.ts`）。評価が暗黙に engine を起こすと、利用者の操作なしに音の経路が立つ（RL-6・§14.0 (25) と同じ考え）。凍結版の `evaluate_orbitscore` も評価せずに同じ文言を返す（`agent-handlers.ts`） |

**N1-a2 で確かめた事実**（§5.3.2 の「未確認」への答え・2026-10-26・`packages/engine/src/audio/rust-engine/daemon-client.ts`）: `DaemonClient.quit()` は `killChildGracefully` で SIGTERM を送り、**子の `exit` を待ってから**返る。ただし `DEFAULT_KILL_TIMEOUT_MS` を過ぎて SIGKILL へ昇格した経路は、SIGKILL を送った直後に `exit` を待たずに返り、`child.killed` が既に true の時も待たずに返る。層 2 の `engine.stop` は `quit()` の後に応答するので、ふつうの経路では daemon の消滅を待っている。昇格の経路の待ちは層 2 からは足せない（daemon の PID は `@internal` の `childPid` でしか取れない）ので、engine 線で `killChildGracefully` が SIGKILL の後も `exit` を待つようにするのを提案する（層 1 の手前の engine の変更・アプリ線は触らない）。

---

## 6. MCP サーバの置き場 = 中継（コードは `packages/session/src/mcp/`）— 10-26 改訂（旧見出し「= 層 2」）

🔴 **改訂（10-26・裁定 4）**: MCP を話すプロセスは**層 2 ではなく、`.app` に同梱した中継**（`orbitscore relay`・`packages/session/src/relay/`）になった。中継は LLM クライアントから stdio で起動され、**それ自身が MCP サーバ**で、ツールを呼ばれるたびに UDS の `/rpc` で層 2 の RPC メソッドを呼ぶ（§4.4・§4.7）。ツールのコード（MCP 層 8 ファイル）は 10-23 のとおり `packages/session/src/mcp/` に移す — 変わったのは**それを走らせるプロセス**だけである。理由は §4.7 の冒頭と §4.7.1（ライブ中に締め出されない）。

- **MCP 層 8 ファイル 1,885 行**（10-23 実測・`mcp-server` / `mcp-tools-{editor,engine,plugins}` / `mcp-types` / `mcp-docs` / `mcp-sdk` / `mcp-registration`・すべて pure・§3.1）を `packages/session/src/mcp/` へ**ファイル移動**する。ツール登録は `OrbitScoreToolHandlers`（`mcp-types.ts:184-235`）という**インタフェース 1 本**を受け取る形に既になっているので、仕事は **このインタフェースを §5.3 の RPC メソッドで実装する**こと（`agent-handlers.ts` 551 行の `*ForAgent` を書き換えるのではなく、**同じ型を別の実装で満たす**）。改訂（10-26）: 実装は**中継の中の UDS の RPC クライアント**で、層 2 の外から同じ型を満たす。ツール名・引数・戻りは **v1 の間は変えない**（§6.1。gated suite がそのまま通ることが D-1 / D-2 の前提）。改訂（10-23）: 4.4.0 で `evaluate(code, options?: {documentPath?})` に引数が増えた（`mcp-types.ts:185-188`・§5.3.1）
- 改訂（10-26）: **ツール固有のロジックの置き場**: `evaluate_orbitscore` の IM.6 の解決（§5.3.1）は、中継が呼び出しのたびに `editor.getState()`（アクティブな `.orbs`）と `session.getState()`（`--workspace-root`）を RPC で取り、凍結版の純関数 `resolveEvaluateDocumentDirectory` を中継の中で走らせる（ファイルの存在の確認は中継のプロセスで行う — 同じ Mac・同じユーザー）。応答の末尾 `(documentDirectory: …)` と `get_log` の窓も中継の中。**どれも RPC の結果を整形するだけ**で、層 2 に無い能力を中継が持つことは無い（D-4）
- 🔴 **`tools/list` の順序と条件付き登録は観測可能な契約**（改訂 10-23・L6）。MCP SDK の `tools/list` は登録順を返すので、凍結版は `buildServer` の呼び出し順（engine → editor → plugins → docs・`mcp-server.ts:98-105`）で順序を固定し、`tests/vscode-extension/mcp-server.spec.ts:396-480` がそれを検査している。handler があるときだけ登録されるのは 5 本（`save_plugin_state` / `open_plugin_ui` / `close_plugin_ui` / `open_plugin_ui_at_cursor` / `register_mcp_server`・`mcp-types.ts:217-234` の optional）。凍結版の拡張は全部の handler を持つので（`extension.ts:268-273`）、外から見える順序は次の 28 本である:

  ```
   1 evaluate_orbitscore   2 start_engine        3 stop_engine          4 get_engine_state
   5 list_audio_devices    6 select_audio_device 7 configure_flash      8 open_file
   9 set_selection        10 run_selection      11 edit_replace        12 get_editor_state
  13 save_file            14 get_document_text  15 get_diagnostics     16 get_log
  17 save_plugin_state*   18 open_plugin_ui*    19 close_plugin_ui*    20 open_plugin_ui_at_cursor*
  21 analyze_audio        22 list_plugins       23 rescan_plugins      24 get_dev_doc
  25 search_dev_docs      26 get_user_doc       27 search_user_docs    28 register_mcp_server*
  （* = 凍結版で handler があるときだけ登録。出典: mcp-tools-{engine,editor,plugins}.ts の登録順）
  ```

  🔴 **決定: `native` でも `headless` でも 28 本すべてを、この順序で登録する**。理由: (a) 条件付きの 5 本はどれも層 2 の RPC で実装できる（plugin 系は engine の機能、`register_mcp_server` は LLM クライアントの設定を書く層 2 の機能）(b) ターゲットごとにツールの集合が変わると、台帳（D-1）が「ツールの差」まで扱うことになる。改訂（10-26）: 一覧と順序は**中継がビルドに埋めて持ち**、上流（層 2）が居なくても `tools/list` に答える（§6.2 の RL-2）。**エディタに依存するツール**（`open_file` / `set_selection` / `run_selection` / `edit_replace` / `save_file` / `configure_flash` / `get_editor_state` / `get_document_text` / `open_plugin_ui_at_cursor`）は、エディタが付いていなければ登録はしたまま **`NO_EDITOR_ATTACHED`** を返す（D-3 と同じ形）
- 🔴 docs の在りか: 凍結版は `__dirname` から user（モノレポ → `extension-bundle`）と dev（モノレポだけ）を探す（`mcp-server.ts:151-154`・`mcp-docs.ts`）。層 2 では起動引数 `--docs-dir`（§4.4・複数可）に置き換え、`docs.*` の `site` ごとに在りかを持つ（§5.3.5）。中継の docs 系ツールは `docs.*` の RPC を呼ぶ。同梱の中身は別冊 [`848-docs-structure-design.md`](848-docs-structure-design.md) §6
- 改訂（10-26）: **TCP の `/mcp` は v1 に無い**（`POST /mcp` → 404）。10-23 の「`/mcp` は `/rpc` と同じリスナー・`--mcp` で有効・アプリの環境設定「MCP ポート」」は削った。HTTP しか話せない MCP クライアントが現れたら、中継に `--http <port>` を MINOR で足す（§5.3.8）
- **MCP ツール = RPC メソッドの薄い写し**（D-4）。改訂（10-26）: 中継は**RPC のクライアントでしかない**ので、GUI が使わない近道を MCP に作る**手段が無い** — D-4 が宣言の検査だけでなくプロセスの構造で守られる（再検討 2.2）
- LLM が第一級ユーザーであることの帰結: **アプリを起動しなくても** headless の `orbitscore session` と中継で同じツール集合に到達できる（D-3）。登録は §6.3

### 6.1 🔴 MCP ツールの v1 関門と、v1 の後に変える時の規則（10-26 新設・裁定 1）

**v1 の間に凍結版と同じにするもの**（台帳 P-03）: (1) ツールの**名前**と `tools/list` の **28 本・順序** (2) **引数**（input schema の名前・型・必須）(3) **戻り**の形（content の種類・`isError` の意味）と、テストと LLM が頼っている文言（`evaluate_orbitscore` の応答の末尾 `(documentDirectory: <dir>|none)`・IM.6 のエラー文言・`get_log` の行の文字列〔debug の `[STEP]` を含む・§5.3.6〕）。**説明文（description）は含めない**（LLM 向けの説明は良くしてよい）。

**「v1」の範囲** = **第 1 リリース（🚪）まで**と読む（owner に確かめる・§14.0 Q-r2-1）。第 1 リリースが出す MCP の表面は凍結版と同じで、その後はアプリに合わせて変えてよい。

**裁定による例外**（v1 の間でも凍結版と違ってよい。一覧はこの表だけで、`mcp-tools-v1.spec.ts` は同じ一覧を持つ）:

| ツール | 違い | 裁定 |
|---|---|---|
| `evaluate_orbitscore` | `document_path` の改行禁止のエラー（3 文言）を返さない。改行を含む実在のパスを解決する（§5.3.1） | 裁定 1「拡張版の通信方式から来た制約は引き継がない」 |
| `register_mcp_server` | 書くのは**中継のスタブの stdio 登録**（秘密もポートも無し・§6.3）。引数 `{scope, port?}` は同じ形で受け取るが、**`port` は使わない**（応答の文言で「port は使わない。中継が動いているセッションを自分で見つける」と伝える。黙って捨てない） | 裁定 4「中継を同梱して繋ぐ」 |

**強制する仕組み**: `tests/protocol/mcp-tools-v1.spec.ts`（S-mcp で新設）。中継の `tools/list`（名前・順序・input schema）を、**凍結版の MCP 層をテストの中で組み立てた `tools/list`**（`packages/vscode-extension/src/mcp-server.ts` の `buildServer` に全 handler のスタブを渡す — `tests/vscode-extension/mcp-server.spec.ts:396-480` と同じ組み立て）と比べ、上の例外の表に無い差があれば red。凍結版のコードがリポジトリに在る間は fixture を作らない（凍結版の bug fix がそのまま基準に入る）。
🔴 **関門を自動で外す**: spec は `apps/OrbitStudio/VERSION` と定数 `MCP_V1_GATE_UNTIL`（第 1 リリースの版。R-app の N4-a で `VERSION` を決める PR で入れる）を比べ、`VERSION` がそれを越えたら「凍結版と比べる」から「アプリのスナップショット `tests/protocol/mcp-tools.snapshot.json` と比べる」へ**自動で**切り替わる。関門が黙って残り続けてアプリが拡張版の形に縛られる（owner の「過去の資産が後々邪魔をする」）ことを、人の記憶に頼らずに防ぐ。

**v1 の後に MCP ツールを変える時の規則**:

1. **足す**（新しいツール・省略可能な引数）: いつでもよい。同じ PR でスナップショットを更新する
2. **変える・消す**（名前・型・必須・戻りの形・頼られている文言）: アプリのリリースごとに入れてよい。同じ PR で (a) スナップショットを更新する（spec が red になるので、レビューで必ず見える）(b) リリースノート（GitHub Releases が正本・§14.0 (19)）に「MCP の変更」を書く (c) **ハーネスの対応表** `tests/e2e/helpers/mcp-tool-adapter.ts`（最初の変更の PR で新設）に `native` / `headless` の呼び方を足し、共有の gated シナリオは能力の言葉のまま残す（`vscode` ターゲット = 凍結版はそのまま通る・§10.2）
3. **別名の互換期間は置かない**: LLM はセッションのたびに `tools/list` を読み、中継と層 2 は同じ `.app` に入っているので食い違わない。古い中継が更新後のアプリに繋いだ時は RL-5（§6.2）が扱う
4. **`protocol_version` との関係**: MCP ツールの表面と RPC のプロトコルは**別の版**を持つ。RPC を壊す変更は `protocol_version` の MAJOR（strict・§5.2）。MCP ツールだけを変える時は `protocol_version` を変えない。MCP の表面の版は**アプリの版**（中継の `serverInfo.version` = `apps/OrbitStudio/VERSION`）。中継と層 2 は同じ MAJOR の時だけ繋ぐ（RL-5）
5. **台帳との関係**: `PARITY_BASELINE_TAG` は凍結版のタグのまま進む（凍結版の側の基準）。MCP ツールを変えても題名の分類は変わらない（題名が確かめるのは能力で、呼び方は対応表が吸収する）

### 6.2 🔴 中継の規則（10-26 新設・裁定 4。出典はセキュリティの再検討 2.3）

中継の異常終了だけが、人の操作が要る経路として残る（§4.7.1 の E10）。だから中継は小さく保ち、次の規則を**検査で**守る（**どれも Linux で完結**する unit。S-mcp）。

| # | 規則 | 理由 | 検査 |
|---|---|---|---|
| RL-1 | **上流の失敗で終了しない**。終了は stdin の EOF と SIGINT / SIGTERM だけ | stdio の終了は Claude Code の対話セッションで手動復帰（§4.7.1） | 層 2 を `kill -9` → 起動し直す。**中継の PID が変わらない** |
| RL-2 | `initialize` / `server/discover` / `tools/list` を**上流なしで**答える。ツールは**ビルドに埋めた 28 本を §6 の順序で**。🔴 **`server/discover` には即答する**（MCP 2026-07-28 を話すなら `DiscoverResult`、旧版だけなら即座に method-not-found）。Claude Code は stdio のサーバへ既定でこの確認を送り、応じないサーバとは「一度遅い接続をした後、7 日間は旧来の方法で繋ぐ」（Claude Code の CHANGELOG 2.1.292・再検討 3.2）— 黙って待たせると**ユニットは緑で実機の起動だけが遅い**形になる | Claude Code がアプリより先に起動しても failed にしない・起動を遅くしない | 層 2 を起動しないまま `tools/list` が 28 本を同じ順序で返す / `server/discover` への応答が即時（時間を測る） |
| RL-3 | `tools/call` は**呼び出しのたびに**ソケットへ繋ぐ（無ければ backoff つきで短く待つ。上限は**置き値**で S-mcp で実測して決める・台帳 P-08）。届かなければ **MCP のツールエラー（`isError: true`）**で「OrbitStudio が起動していない / 再起動中」と書く。プロトコルのエラーやプロセスの終了にしない | LLM が状況を人に伝えられる。Claude Code に failed を付けさせない | 層 2 なしで `evaluate_orbitscore` → `isError` + 文言。その後に層 2 を起動 → 次の呼び出しが通る（**クライアントは何もしない**） |
| RL-4 | **送った後に切れた呼び出しを再送しない**（特に `evaluate_orbitscore`）。「実行されたか不明」と返す | 自動の再送は二重評価（二重に鳴る）を起こす | 層 2 を応答の前に落とす → 結果は不明の文言・`session.evaluate` の到着は高々 1 回 |
| RL-5 | 中継と層 2 の版: `session.hello` の `protocol_version` が同じ MAJOR なら繋ぐ（MINOR は追加だけなので古い中継でも動く）。**MAJOR が違えば `isError` で「OrbitStudio が更新された。`/mcp` で orbitstudio を再接続」**。終了しない | 裁定 (5) = 自動更新を含める。更新の後に、古い `.app` から起動した中継が新しい層 2 に繋ぐ時がある | 版を偽った層 2 に繋ぐ → 文言・中継は生きている |
| RL-6 | 中継は**層 2 を起動しない**（headless を自動で立てない） | 二重 daemon・デバイスの取り合い（#624 のクラス）と、利用者の操作なしに音が出ること（§14.0 (25)「実行は復帰しない」と同じ考え） | — |
| RL-7 | stderr にだけ書く（stdout は MCP のフレームだけ）。Claude Code の停止の手順（SIGINT → 100 ms → SIGTERM → 400 ms → SIGKILL・Claude Code の MCP の文書）の窓の中で終わる | stdio の規則 / Claude Code の止め方 | SIGINT から 100 ms 以内に終了 |
| RL-8 | 中継は小さく保つ（MCP の SDK + ツール層 + RPC クライアント以外を持たない）。秘密を持たない（LLM の経路にトークンが無い） | **中継の異常終了が残る唯一の手動経路** | — |

**発見**（裁定シートの説明文の「発見ファイル」に当たるもの）: 中継は**決まった場所のソケット**で層 2 を見つける — ソケットそのものが発見の手段で、別のファイルに port や鍵を書かない。

| 項目 | 内容 |
|---|---|
| 置き場 | `<runtime-dir>/session.sock`。既定の runtime-dir は `~/Library/Application Support/OrbitStudio/run`。長すぎれば `getconf DARWIN_USER_TEMP_DIR` の下へ退避（§4.7）。中継とアプリは同じ規則で同じ場所を計算する（起動引数 `--runtime-dir` か環境変数 `ORBITSTUDIO_RUNTIME_DIR` が優先） |
| 中身 | 無い（ソケット）。版は接続後の `session.hello` の `protocol_version` で知る |
| 権限 | ディレクトリ 0700（所有者と mode を session が起動時に確かめ、広ければ起動しない）・ソケット 0600 |
| 書き手とタイミング | **session**が起動時に bind し、bind が済んでから ready 行を出す。終了時に unlink する |
| 古いもの | session の起動時に `connect` して `ECONNREFUSED` なら unlink して bind（クラッシュの取り残し）。繋がれば別のセッションが動いているので起動しない（§4.7）。中継から見た古いソケット = `ECONNREFUSED` → RL-3 の `isError` |
| アプリが動いていない時 | 中継は `tools/list` まで答え、呼び出しは `isError`「OrbitStudio が起動していない」（RL-2・RL-3）。中継は層 2 を起動しない（RL-6） |
| headless | `orbitscore session`（既定の runtime-dir）を起動すれば、同じ登録の中継がそのまま繋がる。アプリと同時に使う時は `--runtime-dir` を分け、中継にも同じ値を渡す（登録の `args` か環境変数） |

### 6.3 登録の形（1 回だけ・10-26 新設）

- **コマンドは「安定したパスのスタブ」**: `~/Library/Application Support/OrbitStudio/bin/orbitstudio-mcp`（提案）。理由: (1) 利用者が `.app` を移すと、`.app` の中のパスは壊れる (2) **App Translocation**（ダウンロードした `.app` を初回に元の場所から開くと、macOS がランダムな読み取り専用の場所から起動する・再検討 2.4・二次情報・中）の間に登録すると、そのランダムなパスが登録される。前例: Xcode は `.app` の中のパスを登録させず `xcrun mcpbridge` を登録させる（Apple「Giving external agents access to Xcode」）。スタブは起動のたびにアプリ（bundle id `com.signalcompose.orbitstudio`・§14 (10)）を解決し、中の同梱 node で中継を exec する。アプリは起動のたびにスタブを書き直す（冪等）。**解決の手段・スタブの形式（シェルか小さな実行ファイルか）・Translocation の下での振る舞いは N0-c で決める（未実測）**
- **`session.registerMcp({scope})`**（GUI のメニュー「Claude Code に登録」と MCP の `register_mcp_server` の両方から・D-4）:
  - `scope: "user"`（**既定**・1 回で全プロジェクト）: `claude mcp add --transport stdio --scope user orbitstudio -- <スタブ>` を実行する
  - `scope: "project"`: `.mcp.json` の `mcpServers.orbitstudio` に `{"type":"stdio","command":"${HOME}/Library/Application Support/OrbitStudio/bin/orbitstudio-mcp","args":[]}` を書く。**秘密が無いので、バージョン管理で共有されても漏れるものが無い**。`${HOME}` は Claude Code が `command` の中で展開する（Claude Code の MCP の文書「Environment variable expansion」・再検討 3.3・高）ので、利用者の名前を入れずに済む
  - 🔴 **鍵もポートも書かない**。アプリを立ち上げ直しても、ポートやトークンが変わっても、登録はそのまま
  - サーバ名は **`orbitstudio`**（凍結版の拡張が登録する `orbitscore`〔HTTP・固定ポート〕と別の名前にし、同じ `.mcp.json` で凍結版の行を上書きしない — 拡張版の退役までは両方が並ぶ）
  - Codex は `codex mcp add orbitstudio -- <スタブ>` で同じ形（再検討 2.4）。アプリのメニューに置くかは A-panels で決める
- **ログ**: 中継は秘密を持たないので、F-13 の対象は TCP の `/rpc` のトークンだけになる（§12）

---

## 7. GUI の設計制約とアプリの構成

### 7.1 Swift シェルの面積（裁定 2.2「シェルだけ」）

| 責務 | AppKit | 備考 |
|---|---|---|
| ドキュメント | `NSDocument` サブクラス（`.orbs`・UTF-8） | open / save / autosave / 未保存確認 / 最近使った書類は**標準で付いてくる**（裁定 2.2 の根拠） |
| ウィンドウ | `NSWindowController` + タブ（`NSWindow.tabbingMode`） | 1 document = 1 window。パネル（Engine / Log / Catalog / Docs）は**サイドバー**（`NSSplitViewController`）で同じウィンドウ内 |
| メニュー・キー | メニューバー・⌘Enter = `runSelection`（`package.json` の唯一のキーバインドと同じ） | ⌘Enter は WebView 内の Monaco keybinding が先に受け、変換中（IME composition）は評価しない（D-6） |
| 環境設定 | `NSWindow` + 設定 8 項目の写像（§7.4・改訂 10-23: 旧版の「10 項目」は初版の値で、#502 で 2 項目が消えた） | `UserDefaults`。値は session の起動引数か RPC で渡す |
| WebView | `WKWebView` × 1（エディタ + パネル）+ Docs パネル用の別の `WKWebView`（§4.7） | 改訂（10-23）: 🔴 **層 2 が配る `http://127.0.0.1:<port>/app/` を読む**（本命・§7.3）。`loadFileURL`（`file://`）は同等の代替ではない。トークンは `WKUserScript`（`forMainFrameOnly: true`）で注入し、`/app/` の外へ遷移させない（§4.7）。`WKScriptMessageHandler` は**document の入出力だけ**に使う（§7.3） |
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

**RPC クライアントは WebView の TS**（Swift ではない）— 理由: 補完・診断の描画・playhead・ログパネル・カタログ表示はすべて既存 TS 資産の延長で、Swift を経由すると `WKScriptMessageHandler` の往復が 1 段増えるだけ。Swift シェルは document / window / menu と層 2 の**プロセス管理**に限る。WebView が落ちてもセッションは残る（§4.4）。

🔴 **WebView の配信元（改訂 10-23・旧版の「`file://` でも `http://127.0.0.1/app/` でも設計は変わらない」を撤回）**:

| 配信元 | WebSocket のハンドシェイクで送る Origin | `/rpc` の Origin 検証（§4.7）で | 判定 |
|---|---|---|---|
| **`http://127.0.0.1:<port>/app/`**（層 2 の HTTP リスナーが `/app/**` で静的ファイルを返す） | `http://127.0.0.1:<port>` = Host と同じ（見込み） | 許可リストの 1 件で照合できる（Jupyter の「Origin のホスト == Host」と同じ形） | ✅ **本命** |
| `file://`（`loadFileURL` で同梱 bundle） | `null`（`loadFileURL` のページから外へ出す XHR は `Origin: null` になる — 調査 I-7。WebSocket で同じ値になるかは**未実測**） | 🔴 `null` は sandbox 付き iframe や `data:` URL からも来るので、**許可すると正規のクライアントと区別できない** | **同等の代替ではない**（`null` を許す例外を作らない） |
| 独自スキーム（`WKURLSchemeHandler`・例 `orbitstudio://app/`） | **未確認** | 値が一意なら許可リストに載せられる | 候補として残す（N0-a で Origin の実際の値を測ってから） |

N0-a の測定項目（計画 §3 N0）: (1) 上の 3 つの配信元それぞれで、WebSocket のハンドシェイクが送る **Origin の実際の値**（node の `ws` サーバに記録させる）(2) **ATS（App Transport Security）の `NSAllowsLocalNetworking` が要るか** — macOS 14 以降、ATS は IP アドレスへの接続を既定で許さない（Apple の `NSAllowsLocalNetworking` の文書）。loopback の `ws://127.0.0.1` / `http://127.0.0.1` が対象になるか、WKWebView の中の通信に掛かるかは**未確認**なので実測で決める（§9.2 の一覧にも載せた）。`/app/` を本命にしたので、`/app/` の bundle（Monaco + RPC クライアント + パネル）は `.app` の `Contents/Resources/web/` に置き、session が `--web-dir` で受けて配る（§9.1）。

### 7.4 能力のパリティ（拡張の `contributes` → アプリ）

改訂（10-26・裁定 1）: 見出しを「表面のパリティ」から改めた。下の「分類」の **native 必須**は「**その能力がアプリにある**」の意味で、置き場・画面・パネル・コマンドの構成は**参照**（作り直してよい）。たとえば「Engine パネルのボタン」は能力（engine を起動・停止できる）の一つの置き方で、A-panels でもっと良い形が見つかればそちらを採る。能力が減らないことは D-1（gated の題名）と D-4（GUI と MCP の両方から届く）が数える。

| 拡張の表面 | アプリでの置き場（参照） | 分類 |
|---|---|---|
| `toggleEngine` / `stopEngine` / `restartEngine` + 登録のみの `engineViewToggleEngine`（Engine ビューの click） | Engine パネルのボタン + メニュー「Engine」。改訂（10-23）: `restartEngine` は **`engine.stop` + `engine.start` の合成**（新メソッドなし・凍結版の 2,200 ms の sleep は `engine.stop` が daemon の終了を待つ契約で不要・§5.3.7） | native 必須 |
| `runSelection`（⌘Enter） | Monaco keybinding → `editor.runSelection` 相当を WebView 内で完結（選択テキストを `session.evaluate` へ。subject-block は層 2） | native 必須 |
| `selectAudioDevice` / `engineViewSelectDevice` / `listAudioDevices` | Engine パネル（`engine-view.ts` の pure なノード整形を WebView で描く） | native 必須 |
| `configureFlash` + 設定 `flash*` 4 項目 | 環境設定（flash は Monaco の decoration で実装） | native 必須 |
| `rescanPlugins` / `browsePlugins` | Catalog パネル。改訂（10-23）: `browsePlugins` は **`plugin.list` を描き、選んだ名前を Monaco の中で挿入する**（凍結版の QuickPick + エディタへの挿入・`plugin-commands.ts:35-…` と同じ結果。新メソッドなし） | native 必須 |
| `openPluginUiAtCursor`（改訂: #939・4.2.0・右クリック → カーソル下の 1 つの UI）+ `open_plugin_ui_at_cursor` | Monaco のコンテキストメニュー → `plugin.openUiAtCursor()`（解決は層 2・§5.3）。🔴 **ネイティブ版で初めて右クリックが自動テストできる**（memory `native-app-unlocks-gui-test-automation`・拡張版では computer-use が IDE を click tier に固定するため手動だった） | native 必須 |
| `registerMcpServer` + 設定 `mcpServer.port` | メニュー「Claude Code に登録」（`session.registerMcp`・中継のスタブを 1 回だけ登録・§6.3）。改訂（10-26）: 設定 `mcpServer.port` は**引き継がない**（TCP の `/mcp` が無い。通信方式から来た表面・裁定 1） | native 必須（能力 = LLM を繋げる） |
| `openDocs` / `openDevDocs` / `openDevDocsPanel` + Learning view | Docs パネル（`/app/` とは**別の WKWebView**で `/orbitscore/` を表示・§4.7。改訂 10-23: 資産は `get_user_doc` と同じ同梱の user サイト — 凍結版 4.2.1 の同梱を引き継ぐ・D-9。dev サイトは同梱しないので `openDevDocs*` は `.app` では「モノレポのチェックアウトでだけ読める」案内を出す・§5.3.5） | native 必須（範囲は §14 (11)） |
| `startEngineDebug` + 設定 `engineDebug` + 登録のみの `engineViewToggleDebug`（Engine ビューの click） | 環境設定「デバッグログ」= `engine.start({debug})` | native 必須（表面は簡素化） |
| `reloadWindow` / `openWalkthrough` + 登録のみの `showCommands`（ステータスバーの click → コマンドの QuickPick・`extension.ts:126,153`） | **VS Code 固有**（`showCommands` の役目はアプリではメニューバーが持つ） | 🔴 §14 (11) |
| `forceKillScsynth` + 設定 `scsynthPath` / `engine` | **無し**（SC 削除 #502・改訂: 09-18 の `contributes` に既に無い。設定は 8 項目） | not-applicable |
| 設定 `audioDevice` / `playheadPalette` | 環境設定 | native 必須 |
| status bar「🎵 OrbitScore: Stopped / Playing」 | ウィンドウ下部のステータス（`transport.state` を描く） | native 必須 |
| OutputChannel「OrbitScore」 | Log パネル（`session.getLog` + `log.line`） | native 必須 |
| Diagnostics（赤線）/ 補完 | Monaco マーカー / `CompletionItemProvider`（計算は層 2） | native 必須 |
| TextMate 文法 `orbitscore-audio.tmLanguage.json` | 🔴 Monaco は TextMate をそのまま読まない。`monaco-textmate` + `vscode-oniguruma`（WASM）で流用するか、Monarch へ書き直すかは **N0-a の spike で決める**（判定基準: 既存文法との一致を 20 譜面のトークン列で機械比較） | native 必須 |
| `capabilities.untrustedWorkspaces` | 概念が無い（アプリは常に信頼して開く = DAW と同じ・656 §16 (1)） | not-applicable |
| （VS Code が無料で提供していたもの・`EDITOR_HOST_AND_APP_SIZE.md` §1.2）検索 / 置換・undo / redo・マルチカーソル | Monaco 標準機能（`ELECTRON_APP_PLAN.md` 5.2 の列挙どおり。自前実装なし） | native 必須（Monaco が持つ） |
| 同・複数ファイル・最近使った書類・未保存確認 | `NSDocument` + ウィンドウのタブ（§7.1） | native 必須 |
| 同・設定 UI・キーバインド | 環境設定（設定 8 項目）・メニューの accelerator。キーバインドの**カスタマイズ UI は作らない**（⌘Enter 固定） | native 必須（範囲は §14 (11)） |
| （`ELECTRON_APP_PLAN.md` 5.4 の列挙）ステータスバーの **BPM** とカーソル位置 | `transport.state` に tempo を含めて描く / Monaco の cursor イベント | 追加候補（拡張には無い表面。台帳では `not-applicable`、実装は A-panels の余力で） |

---

## 8. ディレクトリレイアウト（確定案）

```
rust/crates/                     層 1（現状のまま・裁定 2.4）
packages/engine/                 DSL 意味論のライブラリ + 凍結版 REPL 入口（cli-audio.js repl）。🔴 新ラインの機能は足さない（§4.5）
packages/session/                層 2 のプロセス host（新設）:
  src/cli.ts                       `orbitscore session --runtime-dir --port --token-file --docs-dir --web-dir --workspace-root --parent-pid …`（§4.4）/ `orbitscore relay`（中継の入口・§6）
  src/rpc/                         JSON-RPC over WebSocket（サーバ・逆方向リクエスト・イベント）。UDS と TCP の 2 リスナー + TCP だけのトークン / Host / Origin の検査（§4.7）
  src/eval/                        評価の受付口。段階 1 は凍結版の写し（足場・台帳 P-01・凍結版 `createReplSession` との差分テストつき）→ 段階 2 で #997 の評価のかたち（§4.5.1）
  src/mcp/                         MCP のツール層（拡張から移動）・mcp-registration.ts。🔴 改訂（10-26）: **走るプロセスは中継**（§6）。`OrbitScoreToolHandlers` を RPC クライアントで満たす
  src/relay/                       中継の入口（stdio の MCP サーバ + UDS の RPC クライアント・§6.2）。10-26 追加
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
  LICENSE                          Apache-2.0（定義だけ・§5.8・§14.0 (9)。10-26 追加）
  session/v1/*.schema.json         正本
  gen/ts/  gen/swift/              生成物（コミットする・`npm run protocol:check` で差分ゼロを検査）
tests/repo/native-provisional-ledger.ts / .spec.ts   暫定物の台帳と検査（§1.4.2・10-26 追加）
tests/protocol/mcp-tools-v1.spec.ts                  MCP ツールの v1 関門（§6.1・10-26 追加）
```

- **`packages/engine` は rename しない**（§14 (2)・推奨「しない」）。理由: 凍結版の拡張が `engine/dist/cli-audio.js` を同梱・実行しており（`engine-process.ts:154`）、rename は凍結版のビルド経路を触る。層 1 / 2 の曖昧さは **`packages/session` を層 2 の名前として立てる**ことで解消する（「engine = DSL ライブラリ」「session = 層 2 プロセス」「orbit-audio-* = 層 1」）
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

`OrbitStudio.app`（`.dmg`）= Swift 本体 + `Contents/Resources/node/`（**同梱 Node・arm64**）+ `session/`（`packages/session` dist + `node_modules`〔`@julusian/midi` の `.node` を含む〕）+ `bin/darwin-arm64/`（7 バイナリ + `std-plugins/Gain.clap`・`copy-daemon-bin.sh:120-135` と同じ集合）+ `web/`（Monaco bundle + RPC クライアント + パネル。session が `--web-dir` で受けて `/app/` で配る・§7.3）+ **`docs/`**。改訂（10-26）: 中継は `session/dist/cli.js relay`（`packages/session` の中・同梱 node で走る）なので**別のバイナリは増えない**。LLM クライアントに登録する**スタブ**（§6.3）は `.app` の外（`~/Library/Application Support/OrbitStudio/bin/`）にアプリが起動のたびに書く。スタブをシェルにするか小さな実行ファイルにするか（後者なら署名・公証の対象）は N0-c で決める（**未実測**）。

🔴 改訂（10-23）: `docs/` は**凍結版 4.2.1 の同梱を引き継ぐ**（D-9）。凍結版は `scripts/copy-user-site.sh` で user サイト（Markdown 45 本 + ビルド済み dist）を拡張パッケージの内側へコピーして `.vsix` に入れ、dev サイトは owner 決定で同梱しない（#954 / PR #955）。旧版（09-18）の「凍結版には docs の同梱が無いので新設」は、旧版の日付当日に #955 で偽になっていた。アプリで新しいのは**同梱の形**（user サイトの Markdown + ビルド済み HTML + DSL 仕様 + manifest）と、どの段で（§9.2 段 2）、どう検査するか（D-9・`verify-app.sh`）で、正本は別冊 [`848-docs-structure-design.md`](848-docs-structure-design.md) §6。凍結版の `copy-user-site.sh` と同じ選別を 2 本書かないよう、別冊 §6.3 の `build-docs-bundle.mjs` は同じ `docs:build:user` を呼ぶ

- **node 同梱**は W-22（owner 2026-09-03 Q-656-8・旧アプリ向けの裁定）を新ラインへ引き継ぐ前提で書く。**引き継ぎの確認は §14 (3)**。代替（Bun の単一実行ファイル）は N-API addon の互換が未検証なので採らない
- daemon の解決は `ORBIT_AUDIO_DAEMON_PATH`（env・`daemon-client.ts:185`）で明示。engine 側の変更なし

### 9.2 署名・公証（656 §5 を流用・SC 行を消す）

`make-local-release.sh`（app 版）の段を 656 §4.2 の 12 段に対応づける:

| 656 の段 | app 版 |
|---|---|
| 1 preflight | 同じ（git clean・SHA・**tag = app の版**・§14 (14)） |
| 2 build | `npm run build`（`packages/session` を含む）+ `copy-daemon-bin.sh` 相当（7 バイナリ + `Gain.clap`）+ `swift build -c release` + 改訂: **docs のビルドと選別**（`npm run docs:build -w @orbitscore/user-site` + 別冊 §6.3 の `build-docs-bundle.mjs` → `Contents/Resources/docs/`。**同じ commit から HTML と Markdown を作る**ので両者は乖離しない） |
| 3 package / 4 verify-vsix | **失効**（vsix は凍結版の `release.yml`） |
| 5 stage-app / 6 trim / 7 embed | **`make-bundle.sh`** に置き換え（`.app` を組み立てる。trim も embed も無い） |
| — | **`verify-app.sh`**（§9.0）。落ちたら exit 1。改訂（10-26）: **暫定物の台帳の spec を release モード（`ORBIT_RELEASE_PREFLIGHT=1`）で呼ぶ**（D-11・§1.4.2）。足場・暫定の消費者・置き値の印が 1 つでも残っていれば落ちる |
| 8 sign | 同じ（内側から・`--deep` 無し） |
| 9 notarize / 10 smoke / 11 manifest / 12 prune | 同じ（smoke は改訂 10-26: 「`.app` を起動し、`.app` の中の中継を stdio で起動して `tools/list` が 28 本を返し、`get_engine_state` が通る」まで。音の確認は gated `native`） |

順序 **build → `make-bundle.sh` → `verify-app.sh` → 内側から署名（node・7 バイナリ・`.node`・`Gain.clap`・Swift 本体）→ `.app` 署名 → dmg → `notarytool submit --wait` → staple → `spctl --assess`**。identity `Developer ID Application: SIGNAL COMPOSE K.K. (ZWULF5LA37)`・ASC API キー（656 §5.2）。

🔴 **entitlements は推測で書かない**（656 §5.3 の実測手順をそのまま使う）。候補は 656 の 4 つに **node の JIT**（V8 は hardened runtime 下で `com.apple.security.cs.allow-jit` 相当を要するのが Electron の公知の作法。**本リポジトリでは未実測**）を足す。改訂（10-23）: entitlements ではなく `Info.plist` の項目だが、同じ「推測で書かず実測で決める」一覧に **ATS の `NSAllowsLocalNetworking`**（`NSAppTransportSecurity` の下）を足す — macOS 14 以降 ATS は IP アドレスへの接続を既定で許さないので、WebView の `http://127.0.0.1:<port>/app/` と `ws://127.0.0.1:<port>/rpc`（§7.3）が対象になるかを N0-a で測る（**未確認**。対象にならなければ入れない）。停止条件も 656 §5.3 と同じ（entitlements を足しても 3rd-party が読めなければ報告して止まる）。

一方通行（656 §5.2 の表がそのまま効く）: **署名 Team ID / `CFBundleIdentifier` / 配布物名**。bundle id は VSCodium 既定ではなくアプリ固有になるので **初回署名前に owner が確定**（§14 (10)）。

### 9.3 パイプライン

- `release-app.yml`（新設・tag `app-v*`・macos-14・`paths` は `apps/**` `packages/session/**` `packages/engine/**` `protocol/**` `rust/**` `scripts/**`）。**手元の `make-local-release.sh`（app 版）と同じ 1 本を呼ぶ**（656 §5.4「CI に別実装を書かない」）
- 既存 `release.yml`（`.vsix`）は凍結版のために生きる。SC ステップの削除は §12.5（凍結前・#502）
- tag 名前空間は §14 (4)。推奨は裁定 §2.7 の案どおり `ext-v*` / `app-v*`
- 🔴 改訂（10-26・§14.0 (5) = B）: **自動更新を第 1 リリースに含める**。既定で有効にし、利用者が環境設定で切れる（opt-out）。足すもの: 更新の仕組み（Sparkle 2 が候補・**未検証**・N4 で確定）・appcast の置き場（GitHub Releases か Pages）・更新の署名鍵の管理（Sparkle 2 なら EdDSA）・`release-app.yml` が appcast を更新する段。署名・公証を通した `.app` の上に載せる（N4 の中で署名・公証の後）。GitHub Releases からの手動 DL も残す

### 9.4 Swift の CI（§9 未検証項目への答え）

per-PR macOS ランナーは owner 方針で回さない（`rust-ci.yml:1-24`）。したがって **Swift のコンパイルは手元のマージ前ゲート**（`swift build -c release` + `make-bundle.sh` + gated `native`）で担保し、CI は tag 時の `release-app.yml` だけ（§14 (6)・推奨）。CLAUDE.md「マージ前ゲート」の 3 行に **`swift build` を無条件で足す**（条件分岐を付けない — 同節の理由と同じ）。

🔴 改訂（10-26・§14.0 (6) = A + owner の条件）: per-PR の検証は手元で行う。**クラウドに出した作業は、完了後に手元で引き継いでゲートを回す**（クラウドの緑はマージの根拠にしない）。GitHub の macOS ランナーは per-PR では使わない。**tag 時に GitHub で署名・公証・`xcrun stapler` を回すか**は、それで認証の扱いが楽になるかと、リリースの頻度・コストで決める（第 1 リリースの前に・手元で回す形でも成立する）

---

## 10. 拡張版との関係 — 「回帰の検算台」として使う具体（10-26 改訂・旧見出し「仕様書として使う」）

🔴 **改訂（10-26・裁定 1・裁定 6）**: 拡張版は**仕様書ではなく、回帰の検算台**である。拡張版が答えるのは「同じ DSL のコードを流した時に、アプリでも同じ結果になったか」（D-1 / D-2）と「人と LLM ができることが減っていないか」の 2 つだけで、**アプリの形を決めるものではない**（owner の全体への意見「VSIX版にあまり引っ張られることなく…過去の資産が後々邪魔をすることがないようにしてほしい」・第 1 回）。拡張版は**書き直さない**（§14.0 (7)）。凍結のまま退役まで保ち、退役の時に検算台としての役目も終える（台帳 P-09）。将来、VS Code や他のエディタから繋ぐ日は、**公開したプロトコル**（`protocol/`・Apache-2.0・§5.8）に繋ぐ一般の窓口として作る。その時、相手が VS Code である必要は無い。

### 10.1 何を検算に使うか（3 層）

| 層 | 正本 | ネイティブ版での使い方 |
|---|---|---|
| **DSL の意味論** | `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` + `docs/specs-v2/` | 変わらない。実装も **`packages/engine` の 1 本**を両 host が使う（§10.3） |
| **振る舞い（回帰の検算台）** | 基準タグ（`PARITY_BASELINE_TAG` = v4.4.0・§1.2 D-1）時点の gated suite（`tests/e2e/orbitstudio-mcp-gated.spec.ts`・改訂 10-23: **7,855 行 / 56 `it`**）+ golden（`output-line-expectations.ts` 222 行 / `rack-chain-gain-expectations.ts` 34 行・10-23 も同じ）+ 台帳（`dsl-coverage-ledger.ts`・09-18 は空だったが、10-23 は 4.3.0 の `random-pitch` / `random-binding` の 2 行・`dsl-coverage-ledger.ts:27-40`。ラチェットの baseline 側が母集団）+ ラチェット（`dsl-e2e-coverage.spec.ts`）+ cold-install（`vsix-cold-install-gated.spec.ts`・#873 / #954） | **同じ suite を native / headless ターゲットで回す**（§10.2）。D-1 / D-2。改訂（10-23）: docs 系ツールは `orbitstudio-mcp-gated.spec.ts` には今も 1 本も無いが、**cold-install の gated が `assertDocsBundled`（`vsix-cold-install-gated.spec.ts:155-175`: `get_user_doc` 成功 / `get_dev_doc` は unavailable / `GET /orbitscore/` 200）を持つ**ほか、通常の vitest に HTTP 往復の `tests/vscode-extension/mcp-server-docs-http.spec.ts` がある。ネイティブ版はこの cold-install の検査を `.app` 版に写す（D-9） |
| **編集面の能力** | 拡張の `contributes`（§7.4 の表）と `extension.ts` の各コマンド実装 | 「どの能力をどこに置いたか」の**パリティ台帳**（§1.2 D-1）。実装は読み替える（コピーしない）。改訂（10-26）: 置き方は参照で、アプリに合う形に作り直してよい（§7.4） |

### 10.2 E2E をどう移すか — ハーネスをターゲット非依存にする

- `ORBIT_GATED_TARGET = vscode | native | headless`（既定 `vscode`・凍結版との互換）。差は**起動と MCP ポートの取り方だけ**:
  - `vscode`: 今日のまま（stock VS Code + `--extensionDevelopmentPath` + `ORBITSCORE_MCP_PORT`・`orbitstudio-mcp-gated.spec.ts:821-841`）。凍結版の `/mcp` はトークンを持たないので、ハーネスはトークンを送らない
  - `native`: `OrbitStudio.app/Contents/MacOS/OrbitStudio` を **`ORBITSTUDIO_RUNTIME_DIR=<短いパス>`** 付きで起動する（改訂 10-26: 旧 `ORBITSCORE_MCP_PORT` → session の `--port --mcp` は消えた）。MCP は**中継を stdio で起動して**話す（`node packages/session/dist/cli.js relay` に同じ `ORBITSTUDIO_RUNTIME_DIR`）。起動する `.app` は `ORBIT_GATED_APP_PATH`（省略時はリポジトリ内のビルド成果物。リリース成果物を指せば 656 §6.2 の「同じ E2E を成果物へ」= E2E-D3 になる。成果物を指す時は中継も `.app` の中のものを使う）。teardown は PID オラクル（中継のプロセスも数える）。`openWorkspace` は起動時にフォルダ（`tmpRoot`）を渡すかどうかに写す（§4.5.2）
  - `headless`: `node packages/session/dist/cli.js session --runtime-dir <短いパス> [--workspace-root <tmpRoot>]`（TCP を開かない）+ 同じ中継を stdio で起動
- 🔴 **ハーネスの分離とトークン**（改訂 10-26・旧「ハーネスがトークンを知る経路」を置き換えた）: `native` / `headless` のハーネスは**利用者と同じ経路（中継）**を通る（CLAUDE.md「E2E は実利用の経路を映す」・memory `e2e-must-mirror-real-usage`）。中継は UDS で繋ぐので、**ハーネスはトークンを知る必要が無い** — 10-23 の `ORBITSCORE_SESSION_TOKEN_FILE` と `Authorization: Bearer` の載せ替えは削った。分離は runtime-dir で行う: ハーネスは `/tmp/orbe2e-XXXXXX/r`（33 文字・ソケットまで含めて 46 文字。macOS の `/tmp` は `/private/tmp` へのシンボリックリンクなので、実体のパスの長さで測る）を作って 0700 にし、アプリ（または headless の session）と中継の両方に同じ値を渡す。**利用者が動かしているアプリのソケット（`~/Library/Application Support/OrbitStudio/run/`）には触れない**。TCP の `/rpc` の拒否（D-10 の (1)）は unit と gated `native` の 1 本で確かめ、その 1 本は WebView が受けたトークンを読まない（拒否だけを見る）。ハーネスの変更（`helpers/mcp-client.ts` に stdio の transport を足す・今日は SDK 非依存の生 HTTP・`helpers/mcp-client.ts:1-10`）は束 S-mcp の tests 変更で、`vscode` ターゲットは何も変わらない
- シナリオ本体（MCP ツール呼び出し・capture の判定）は**1 文字も変えない**。これが「両フロントエンドを同じハーネスが検証する」の実体。改訂（10-26）: v1 の間は MCP ツールが凍結版と同じなので、これはそのまま成り立つ。**v1 の後にアプリの MCP ツールを変える時**は、シナリオ本体ではなく**ターゲットごとの対応表**（`tests/e2e/helpers/mcp-tool-adapter.ts`・最初の変更の PR で新設）に「`native` / `headless` ではこのツールをこう呼ぶ」を足す。シナリオは能力の言葉（「評価する」「デバイスを選ぶ」）で書かれたまま残り、`vscode` ターゲット（凍結版）はそのまま通る（§6.1）
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
| 🔴 改訂（10-23）: **`/rpc` と `/mcp` のどちらにも認証を付けない（現状踏襲）** | 旧版はこれを採り「`/rpc` にだけ token を付けても意味が無い」と書いたが、前提 2 つが偽だった: 現行 `/mcp` は MCP 仕様 2025-11-25 の MUST（Origin 検証）を満たさず、WebSocket の `/rpc` は CORS の対象外で `/mcp` の偶然の preflight 防御も無い。**両方にトークン + Origin**（§4.7） |
| `/rpc` にだけトークン | 片方だけでは `/mcp` 経由で同じ `evaluate` に届く（旧版の整合性の論理はこの点では正しい）。改訂（10-26）: TCP の `/mcp` が無くなったので、この行の前提は消えた |
| LLM の経路を HTTP + トークンにする（10-23 の §14 (23) 推奨 A = 起動のたびに登録を書き直す / 永続トークン + 固定ポート / Claude Code の `headersHelper` + 固定ポート）（10-26 追加） | Claude Code の再接続の上限（HTTP の途中切断は約 31 秒・初回接続は 3 回）に縛られ、アプリの立ち上げ直し・ポートの衝突・Claude Code がアプリより先に起動、の日常の出来事で**手動**になる（§4.7.1・再検討 2.1）。`headersHelper` は実在するが（Claude Code の MCP の文書）Claude Code 専用で、再接続の上限は残る。HTTP の口を開ける限り MCP SDK の勧告（GHSA-46jr-4wx8-v453 ほか）に追従し続ける費用もかかる |
| 中継を「バイト中継」にして MCP サーバは層 2 に置く（10-26 追加・再検討の (a-i)） | 層 2 が落ちている間の `initialize` / `tools/list` と、層 2 の再起動の後の `initialize` の再送を中継が肩代わりする必要があり、結局 MCP を理解する中継になる（再検討 2.2） |
| 中継が層 2（headless）を自動で起動する（10-26 追加） | 二重 daemon（#624）と、利用者の操作なしに音が出ること（§14 (25)「実行は復帰しない」）。RL-6 |
| TCP の `/rpc` で Origin の欠落を許す（10-23 の規則 2「無い → 次へ」）（10-26 追加） | 欠落を許したのは非ブラウザの LLM クライアントのためで、それが UDS へ移った |
| `--mcp` を別名として残す（10-26 追加） | 拡張版の通信方式から来た表面（裁定 1「引き継がない」）。残すと「`--mcp` を付けたのに `/mcp` が無い」形の混乱を作る |
| F-12 で session の再起動を人のボタンに任せる（10-26 追加） | 人が気づいて押すまで LLM の呼び出しが `isError` のままになる（D-12 の E2）。owner の原則「状態は復帰する」とも合わない。連続して落ちる時だけボタンに切り替える（§12） |
| トークンを WebSocket の URL のクエリ文字列か独自ヘッダで渡す | ブラウザの `WebSocket` は独自ヘッダを付けられず、クエリ文字列はアクセスログと履歴に残る。`session.attach` の params で渡す（§4.7） |
| トークンを配信する HTML に埋める | MCP Inspector GHSA-vcc9-3xgm-p9v4 の型（DNS rebinding で HTML ごと盗める）。Swift から `WKUserScript` で注入する |
| `Origin: null` を許可する（`file://` の WebView のため） | `null` は sandbox 付き iframe や `data:` URL からも来るので、許すと正規のクライアントと区別できない。WebView は `http://127.0.0.1:<port>/app/` から配る（§7.3） |
| keep-alive で子が親の死を知る（Sonic Pi 型） | タイマーが遅れると生きている親の子を誤って殺しうる。stdin の EOF（主）+ 親 PID（補助）にする（§4.4） |
| session が cwd を暗黙のワークスペースにする | 起動した場所で評価結果が変わる隠れた状態になる。`--workspace-root` で明示する（§4.5.2） |
| `session.evaluate` に凍結版の `documentDirectory` の 3 値（省略 = 前回値を保持）を写す | stdio の REPL セッションが状態を持つことの副産物を wire に持ち込む。in-process の層 2 には状態を持つ理由が無い。`documentDirectory` を毎回必須にする（§5.3.1） |
| 評価の単位を `repl-mode.ts` から `packages/engine` へ切り出して共有する（裁定シートの「C 凍結を破って共有」） | `repl-mode.ts`（凍結）を触り、アプリの区切り方を変えると拡張版も変わる。改訂（10-26）: owner 裁定で**段階を分ける**（§4.5.1）に決まった。段階 1 は層 2 に写して差分テストで一致を守り、段階 2 で #997 の評価のかたちに置き換える |
| 層 2 へ移すのと同時に、評価の区切り方を新しくする（裁定シートの「B 最初から新しい評価で」・10-26 追加） | 実機テストの音が変わった時、移行のバグか意図した変化か区別できない（計画 §2.2 の検算の機会）。新しい評価のかたちの設計（#997）も先に要る |
| 足場（段階 1）を「動いているから」と残したまま出荷する（10-26 追加） | owner の条件「ちゃんと忘れずに最後まで移行をするように」。足場は台帳 P-01 で、リリースの preflight が落とす（D-11） |
| 拡張を新 RPC の薄いクライアントに書き換える | 改訂（10-26・§14.0 (7)）: **やらない**（owner 裁定）。退役させるものを層 2 に合わせて書き直すと、層 2 の作りが VS Code の都合に引っ張られる。他のエディタから繋ぐ日は、公開したプロトコルに繋ぐ一般の窓口として作る（§10） |
| タイミングの判断を「聞こえるかの実測の後」とだけ書いて、時期と規則を決めない（10-26 追加） | 判断が「いつか」になる。T-1（N0-d）と判断の規則を先に置いた（§4.6・台帳 P-06） |

---

## 12. 失敗モードと観測手段（🔴 検証手段は CLAUDE.md「テストの積み上げ規律」で決め直す・本表は対象の一覧）

| # | 失敗 | 兆候 | 観測手段 |
|---|---|---|---|
| F-1 | host が死んで session / daemon が孤児に | 二重出力・デバイスが掴まれたまま | 🔴 改訂（10-23）: **機構と観測を分けて持つ**。**機構** = session が stdin の EOF（主）と `--parent-pid` の生存確認（補助）で自分から終了する（§4.4・`packages/session` に新設）。daemon 側の同じ機構は層 1 なので **engine 線への申し送り**（daemon は stdin `'ignore'` で起動される・`daemon-client.ts:853-856`）。**観測** = gated teardown の PID オラクル（D-1 の前提・`orbitAudioDaemonPids()` を helper へ）+ S-rpc の unit「session の stdin のパイプを閉じると、session が畳む経路を通って終了する」（Linux で完結） |
| F-2 | WebView から `ws://127.0.0.1/rpc` へ繋がらない（Origin が想定と違って 403 / ATS が loopback を止める） | skeleton で音が出ない | 改訂（10-23）: 配信元は `http://127.0.0.1:<port>/app/` が本命（§7.3）。N0-a で 3 つの配信元の Origin の実際の値と `NSAllowsLocalNetworking` の要否を測る。`/rpc` の拒否は理由つきで `log.line`（`session`）に出す（値は出さない・§4.7） |
| F-3 | IME 変換中の ⌘Enter が評価を起こす | 未確定文字列が評価される | D-6 の owner 確認項目に明記 |
| F-4 | 逆方向リクエストのデッドロック（層 2 が editor を待ち、editor が層 2 を待つ） | `run_selection` がタイムアウト | 逆方向は**通知か短いリクエスト**に限り、editor 側は RPC を await しない設計（`editor.runSelection` は選択テキストを返すだけ・評価は層 2 が別リクエストで行う） |
| F-5 | 診断が Monaco と MCP で食い違う | `get_diagnostics` と赤線が違う | 計算が 1 箇所（§5.5）なので構造で潰す。E2E: `get_diagnostics` の件数と `editor.diagnostics` 通知の件数が一致 |
| F-6 | GUI だけの近道が入る | LLM が到達できない操作 | D-4（`x-surfaces` の検査） |
| F-7 | スキーマと生成物のずれ | Swift の decode 失敗 | `npm run protocol:check`（差分ゼロ） |
| F-8 | 署名後にファイルを削る | notarization 失敗 | 656 裁定 7（build → trim → sign の順を `make-local-release.sh` に固定） |
| F-9 | `[STEP]` 相当の通知が多すぎて WebSocket が詰まる | playhead が遅れる | N2 で 1 秒あたりの通知数を実測し、閾値を超えたら間引き（`atEpochMs` は保つ） |
| F-10 | 拡張（凍結）に新ラインの変更が漏れる | 凍結版のビルド成果物が変わる | `packages/vscode-extension/**` と `packages/engine/src/cli/repl-mode.ts` を触る PR を **CI で警告**（paths フィルタ・bug fix 以外は red にはしない） |
| F-11（改訂） | 同梱 docs が**そのリリースに無い機能**を書いている / 同梱 docs が古い | LLM が存在しない構文を勧める・ユーザーが無い設定を探す | 別冊 §5 の固定文法「未リリース」マーカーを **`verify-app.sh` で 0 件**に強制（D-9）。古さは `docs/manifest.json` の `commit` で追える。**online 取得は v1 では作らない**（別冊 §6.5） |
| **F-12**（10-23 追加） | **層 2 だけが落ちて、アプリは生きている**（session のクラッシュ・OOM・`kill`） | エディタは書けるが評価が通らない・playhead が止まる・音は（daemon が残っていれば）鳴り続けるか止まる | **検知**: Swift の子プロセスの終了（`Process.terminationHandler`）と WebView の WebSocket の切断の両方。🔴 改訂（10-26）: **session の再起動は自動で行う**（状態の復帰）。owner の原則（§14 (25)）「状態は復帰するが、実行は復帰しない」と、裁定 4 の「ライブ中に LLM が締め出されない」（D-12 の E2）の両方から — 再起動を人のボタンに任せると、人が気づいて押すまで LLM の呼び出しは `isError` のままになる。**再評価はしない**（実行は復帰しない・(25)(a) A）。自動の再起動が短い間に続けて失敗した時（回数と時間の窓は置き値・台帳 P-08）だけは自動をやめ、「セッションを再起動」ボタンを出す（落ち続ける session を回し続けない）。**伝え方**: **モーダルでない通知**（ウィンドウ内のバナー。`NSAlert` を出さない = D-5 と両立。Bitwig がプラグインやエンジンの停止をその場の通知と Reload ボタンで伝えるのと同じ形・調査 B-2 / B-4）に「セッションを起動し直した」の 1 行 + 失われたプラグインの状態の一覧（(25)(b) A）+ 「前面の document を再評価」ボタン。**中継（LLM の経路）**は同じ runtime-dir のソケットへ繋ぎ直すだけで、LLM クライアントからは見えない（実行中だった 1 回の呼び出しだけが「実行されたか不明」・§6.2 RL-4）。**再起動**: 旧 daemon が残っていないことを確かめてから（F-1 の daemon 側の機構が engine 線〔#996〕で入るまでは、PID オラクルと同じ手段で残りを止める — 手段は N2 で実測。🔴 この掃除は暫定物で、台帳 **P-05**・#996 の後は「残っていたら `log.line` で知らせる」に置き換える）→ 🔴 **session を前回と同じ port（`--port <前回 bind した port>`）と同じトークンファイル（`--token-file`）と同じ runtime-dir で起動し直す**。理由: `/app/` は session 自身が配っているので、WebView のページの Origin は `http://127.0.0.1:<前回の port>` のままで、port が変わると自分の Origin の規則（§4.7）で `/rpc` が 403 になる。また `WKUserScript` は document の読み込み時にしか注入されないので、トークンが変わると WebView に渡す手段が無い。したがってアプリは**ユーザーが起動した時も** session に `--token-file`（アプリが作る 0600 のファイル・アプリの寿命の間だけ）を渡し、再起動でも同じトークンを使う → WebView は同じ port へ再 attach → **開いている全 document の `editor.didOpen` と `editor.didChangeActive` を再送**（§5.5）。前回の port が bind できない時（別のプロセスが取った）だけは、新しい port で起動して **WebView を新しい `/app/` から読み直す**（Monaco の undo 履歴とスクロール位置は失われる。テキストは `NSDocument` が持つので失われない）。テキスト（`NSDocument`）が完全な真実なので、どちらの経路でも document は失われない。✅ **決めたこと**（§14 (25)・10-26 第 1 回）: (a) 再起動の後に**自動で再評価しない**（再評価ボタン）(b) **テキストの外にあるプラグインの状態**（`plugin.saveState` で保存していない分）が失われたことを通知に 1 行 + `(receiver,index)` の一覧で伝える（一覧はアプリが最後に受けた `engine.state` から作り、取れなければ「一覧は不明」と書く）。参考: 層 2 の**中**では daemon の死を既に扱っている — TS 側が session 状態の権威を持ち、daemon を respawn して再 anchor する（#300・`rust-engine-player.ts:476-486`）。F-12 はその 1 段上の同じ問題である |
| **F-13**（10-23 追加） | トークンがログ・log ring・テストの出力に漏れる | `get_log` の行・アプリのログ・CI の失敗メッセージにトークンの文字列が出る | §4.7「漏れる経路」の表の規則（ready 行は消費して捨てる・attach の params を debug の echo で伏せる・拒否のログに値を出さない・assertion に入れない）+ D-10 の grep（トークン文字列が 0 件）。改訂（10-26）: トークンは **TCP の `/rpc`（WebView）だけ**に残った。LLM の経路（中継・UDS）には秘密が無いので、Claude Code が中継の stderr をログに残しても漏れるものが無い |
| **F-14**（10-26 追加） | **中継のプロセス自身が異常終了する** | Claude Code の `/mcp` に orbitstudio が failed と出る・ツールが消える | §4.7.1 の E10。**人の操作が要る唯一の経路**（`/mcp` で再接続）。機構: 中継を小さく保ち（RL-8）、上流の失敗で終わらない（RL-1 の検査）。観測: Claude Code の表示（黙らない） |
| **F-15**（10-26 追加） | 自動更新の後に、古い `.app` から起動した中継が新しい層 2 に繋ぐ（RPC の MAJOR が違う） | ツールの呼び出しが `isError`「OrbitStudio が更新された」 | §4.7.1 の E8。RL-5（`isError` で再接続を案内・終了しない）。MINOR の違いは自動で繋ぐ |
| **F-16**（10-26 追加） | **暫定物が最終形へ移らないまま出荷される**（足場・暫定の消費者・置き値・申し送りの後始末） | 動いているので D-1〜D-10 は緑のまま。#997 の評価のかたちが入らない・playhead が文字列照合のまま・daemon の残りをアプリが黙って掃除し続ける | §1.4 の台帳と D-11（リリースの preflight が落とす）。観測: 台帳の spec（release モード）と、束 PR の監査の問い「この束が足した暫定物は台帳にあるか」（計画 §5） |
| **F-17**（10-26 追加） | **アプリ全体が落ちて、利用者が開き直す** | ウィンドウが消え、音が止まる（Swift が落ちると F-1 の機構で session と daemon も終わる・§4.4） | owner の原則（§14 (25)）「**状態は復帰するが、実行は復帰しない**」: document は `NSDocument` の自動保存と復元で戻し、評価も再生もしない。session は新しい TCP の port と新しいトークンで起動する（WebView も読み直されるので問題ない）。**LLM の経路は変わらない** — runtime-dir のソケットの場所は同じなので、中継は次の呼び出しから繋がる（§4.7.1 の E3・D-12 の gated 1 本）。開き直すまでの呼び出しは `isError`「OrbitStudio が起動していない」 |

---

## 13. 確信度と反証方法

| 主張 | 確信度 | 反証方法 |
|---|---|---|
| §3.1 の「移す 17 本 4,553 行」（+ 新規 95 行）は `vscode` 無しで動く | 高（`grep -L "from 'vscode'"`・10-23 再測。`import type` は `extension-state.ts` 1 本だけで、それは「消える」側） | `packages/session` へ移して `tsc` が通るか。`__dirname` 相対でリソースを探す箇所（`mcp-docs.ts:29-36`・`plugin-catalog-reader`）は起動引数へ置き換える。**通らなければ、その 1 本を「依存を剥がす」行へ移す**（表の総量は変わらない） |
| §3.1 の「消える 9 本 1,437 行」は層 2 に**不要** | 中（child-engine の stdout 経路は in-process 化で消える、という推論。`engine-lifecycle.ts` の分類規則だけは意味論として写す） | S-mcp で headless の `get_log` / `transport.state` が凍結版と同じ分類（stderr → ERROR・Playing / Ready）を返すこと。**返さなければ「規則を写し忘れた」**であって「ファイルが要る」ではない |
| 拡張の vscode 依存の**行数**は 08-30（4,405）からほぼ動いていない（09-14 4,409 / 10-23 4,452） | 高（`wc -l` の合算） | 依存 15 本の合算を再計算。依存コードが**増えた**なら、新しいファイルに `from 'vscode'` が現れるはず（10-23 の +2 本はどちらも非依存） |
| `OrbitScoreToolHandlers` を層 2 の RPC で実装すれば MCP ツールの表面は不変（改訂 10-26: 実装は中継の中の UDS の RPC クライアント） | 高（インタフェースが型で在る・`mcp-types.ts:184-235`） | S-mcp で gated headless の `tools/list` が凍結版（全 handler）と同じ **28 名を同じ順序**で返す（§6 の表・`mcp-server.ts:98-105` の登録順コメント・`mcp-server.spec.ts:396-480`） |
| ~~docs 系ツールは cold install で動かない~~ → 🔴 **反証済み**（10-23）: user サイトは 4.2.1 から `.vsix` に同梱され、cold install で `get_user_doc` が成功する（`vsix-cold-install-gated.spec.ts:155-175`）。dev サイトは意図的に同梱せず unavailable を返す。代わりの主張: **凍結版の user サイトの同梱は `.app` に引き継げる** | 高（凍結版の同梱と cold-install の検査が既に在る） | `.app` の cold-install（D-7）で `get_user_doc` が 1 章を返さない |
| WebSocket 1 本で複数クライアントと逆方向リクエストが成立する | 高（JSON-RPC 2.0 は双方向を仕様で持つ） | N1-a で 2 クライアント同時 attach のテスト |
| Monaco が WKWebView で IME 込みで動く | 🔴 **低（未検証・裁定 §9）**。改訂（10-23）: 「低」の根拠が増えた — WKWebView は EditContext を持たず textarea 経路を通る（拡張版の実績は予測にならない）、WebKit 固有の未解決 issue が 3 本（monaco-editor #4796 / #5390 / #3549）で、うち #4796 の修正 PR（microsoft/vscode#333909）は未マージ。名の知れた製品で WKWebView の Monaco を出荷している例は確認できなかった（検索の範囲で） | N0-a で D-6 の再現手順 ①〜⑤。崩れたら §1.3 の戻り。上流の修正が入らない時の備えとして Monaco の版の固定とパッチの当て方を N0-a で決める |
| WebView を `http://127.0.0.1:<port>/app/` から配れば、WebSocket の Origin が `http://127.0.0.1:<port>` になり許可リストで照合できる | 中（ブラウザの通常の振る舞いからの推論・WKWebView では**未実測**） | N0-a で 3 つの配信元の Origin を node の `ws` サーバに記録させる（§7.3）。違う値なら許可リストの値を直す（規則は変わらない） |
| `file://` の WebView は `Origin: null` を送る | 中（XHR についての記述・調査 I-7。WebSocket は**未実測**） | 同上。`null` でなかったとしても、`file://` を本命に戻す理由にはならない（区別できる一意の値かを別途確かめる） |
| ATS の `NSAllowsLocalNetworking` が要る | **未確認**（macOS 14 以降 IP アドレスへの接続を既定で許さない、までは Apple の文書。loopback と WKWebView に掛かるかは不明） | N0-a。要らなければ入れない |
| Node の hardened runtime に JIT の entitlement が要る | 中（Electron の公知・本リポジトリ未実測） | N0-c（656 §5.3 の手順） |
| 同梱 node で `@julusian/midi` の N-API prebuild が読める | 中（改訂: #878 が **Electron 同梱 Node 24.18.1** で読めたことを実測・`engine-process.ts:392-396`。素の同梱 node は未実測） | N0-c で `node -e "require('@julusian/midi')"` の port count が拡張版と一致 |
| 層 2 の FIFO 直列化で同時性が今日と同じになる | 高 | N1-b で人間 + LLM の交互評価を `.orbslog` の順序で確認 |
| goldens が native で動かない | 高（層 1 不変） | D-2。動いたら層 2 の配線か capture の窓 |
| Swift は数千行に収まる | 中（未実測） | N2 / N3 で `wc -l` を計画へ戻す |
| SwiftPM だけで `.app` が作れる | 高（Info.plist と bundle 構造は手で置ける） | N0-c の skeleton |
| TCP の `/rpc` のトークン + Origin（欠落も拒否）で T-1（任意の Web ページ）と T-2（別ユーザー）を止められる（改訂 10-26: TCP は WebView だけ） | 高（仕組み: WebSocket のハンドシェイクは CORS の対象外で、ブラウザは Origin を必ず付ける・RFC 6455 §4.1 / §10.2。前例 4 つが同じ形）/ 中（実装の落とし穴 — 調査 X-2 の 3 件・webpack-dev-server GHSA-9jgg-88mc-972h の「何を許すか」で破れる型） | D-10 の (1) の 7 ケース。1 つでも通れば規則か実装が誤り |
| UDS は T-1 から構造的に届かない（10-26 追加） | 高（Web プラットフォームに UDS へ繋ぐ API が無い・再検討 5.5） | ブラウザに UDS へ繋ぐ手段が現れた時 |
| 0700 のディレクトリ + 0600 のソケットで T-2 を止められる（10-26 追加） | 高（XNU の `unp_connect` が書き込み権限を検査・`uipc_usrreq.c:1345`。ディレクトリの検索権限は POSIX。出荷ビルドとの一致は**未確認**だが、0700 だけでも成立する） | 別のユーザーから `connect` を試す手の確認（N2 で 1 回・D-10） |
| 中継で E1〜E3・E5〜E7 が人の操作なしに戻る（10-26 追加） | 中（設計からの推論。前例 ableton-mcp / blender-mcp の振る舞いと同型。Claude Code の再接続の方針には依らない） | §6.2 の RL-1〜RL-3 の検査（層 2 を落として起こし直し、中継の PID が同じで次の呼び出しが通る）と D-12 の gated 2 本。1 つでも通らなければ規則か実装が誤り |
| スタブで `.app` の移動・App Translocation の後も登録が生きる（10-26 追加） | **未実測**（N0-c） | N0-c で `.app` を移してから Claude Code で呼ぶ / ダウンロードしたばかりの `.app` を開いて登録する |
| 中継の起動が Claude Code の起動を遅くしない（10-26 追加） | 中（RL-2 で `server/discover` に即答すれば、Claude Code の 7 日間の旧方式への切り替えを踏まない・Claude Code の CHANGELOG 2.1.292。同梱 node + SDK の起動時間は**未実測**） | S-mcp で中継の起動から `initialize` の応答までを測る（置き値・台帳 P-08） |
| stdin の EOF で session が親の SIGKILL の後に終わる | 中（sclang の前例・`SC_TerminalClient.cpp:472-482`。カーネルがパイプを閉じる POSIX の振る舞いからの推論。OrbitScore では**未実測**） | S-rpc の unit（パイプを閉じる）と N2 の実機（Swift 本体を SIGKILL して session が消える・計画 N2）。消えなければ `--parent-pid` の補助が主になる |
| 評価の単位の写し（§4.5.1）は凍結版と同じ振る舞いをする | 中（差分テストのコーパスに入れた形しか保証しない） | 差分テストに無い入力で D-1 / D-2 の golden が動く。動いたら、その入力をコーパスに足して写しを直す |
| 暫定物の台帳（§1.4）で、足場が残ったまま出荷されることは無い（10-26 追加） | 中〜高（印と台帳の照合・release モードは機械。ただし**印を付け忘れた暫定物**は検査 1 にかからない） | 出荷後に、台帳に無い暫定の形が見つかる。見つかったら台帳に行を足し、付け忘れた経路（どのレビューで見落としたか）を記録する。列挙（§1.4.3）は文書の語からの列挙で、コードの暫定物はコードが書かれる束ごとに増える — 束 PR の監査の問い（計画 §5）に「この束が足した暫定物は台帳にあるか」を足す |
| 5 ms の poll の揺れは capture のオンセットで測れる（10-26 追加） | 中（サンプル単位の読み手は #611 E2E-7 で実績がある。`CLAPTestSynth` が `sample_offset` を守ることはコードで読んだだけで未実測・doc 428 §10） | T-1 の前提チェック（オンセットがブロック長より細かい位置に出る）が通らない。通らなければ楽器を変えるか、doc 428 のとおり E2E-T1 を unit へ降格する |
| 楽器のノートの揺れは `audio()` より大きい（10-26 追加） | 中（経路からの推論: 5 ms の poll + 時刻なしの即時送信 + ブロック先頭。**未実測**） | T-1 で m1 ≤ m0 + 64 フレーム。そうなら PR-Q はゲートにしない |
| docs を `/app/` と同じオリジンに置いても RPC は進まない | 中（トークンが attach で要ることは規則から高。別の WKWebView の間で JS の参照が無いことは WebKit の通常の振る舞いからの推論・**未実測**） | N2 で Docs パネルの WebView から `window.opener` / `parent` 経由で `/app/` の変数に触れるかを確かめる。触れたら docs を別のオリジン（別のリスナー）へ移す |
| `transport.step` の `source` を v1 の wire に入れておけば、engine が位置を持った日に WebView の playhead を差し替えるだけで済む | 高（形は #987 §5.1 の抽象モデルと同じ・省略可能フィールドなので MINOR の範囲で埋められる） | #987 B′ の実装で `StepEvent` の形が変わる（例: 範囲が複数になる）。その時は MAJOR の変更になる。S-rpc の締め（計画 N-1 の確定）で #987 の設計（`987-playhead-source-provenance-design.md` §5.1）と突き合わせ、違っていればその時点で直す（消費者がテストだけのうち） |

---

## 14. 🔴 owner 裁定（記録）と、裁定前の推奨

### 14.0 🔴 2026-10-26 の owner 裁定（第 1 回: 裁定シート・27 件 + 全体への意見 / 第 2 回: 7 件 + 全体への意見）

**この節が下の表の「推奨」より優先する。** owner の意見は原文のまま引いた（表記を直していない）。入力は owner 向けの裁定シート（artifact の db）で、owner は同じ内容を会話にも貼った。第 2 回の生データは裁定シートの db（`decisions` の `r2-*`）。

**第 1 回 — 裁定済み**:

| # | 裁定 | owner の意見（原文） | 本書への反映 |
|---|---|---|---|
| (1) | A 含めない（detach なし） | — | §4.3 のまま |
| (2) | A rename しない | — | §8 のまま |
| (4) | 案どおり（`ext-v*` / `app-v*` + `release-app.yml`） | — | §9.3 のまま |
| (5) | 🔴 **B 含める**（推奨 A と異なる） | 「自動更新は含めたい。optoutだけでもいいので。入れるか入れないかはユーザーが決めるでいいのでは。」 | §9.3 を改訂（既定で有効・環境設定で切れる opt-out） |
| (6) | A（owner の条件つき） | 「per-PRでローカルで行う。クラウドなどにタスクを投げている時は作業完了後ローカルで引き継ぐ。githubのmacOSランナーは使わない。ただtagの時（つまりリリース？）の時だけgithubで認証やステップラーなどの認証が楽になるなら使うのもありだとは思っている。リリース頻度とコスト次第。」 | §9.4 に条件を追記 |
| (8) | A 1 つまで | 「ただし、VScodeなどのように複数のファイルをエディットする可能性はあるので、エディタクライアント＝１テキストファイルではない。」 | §5.4 に「1 クライアントが複数の document を持つ」を明記（§5.5 の `didOpen` は uri ごとなので形は既にそうなっている） |
| (10) | A `com.signalcompose.orbitstudio` をそのまま使う | — | §9 |
| (11) | 推奨どおり（5 項目とも） | — | §7.4 |
| (13) | 含める（前提どおり） | — | 🚪 の判定 |
| (14) | A `apps/OrbitStudio/VERSION` | — | §9 |
| (15) | A user サイト（ja + en）+ DSL 仕様 | — | 別冊 §6.1 |
| (16) | A 固定文法 1 行 + frontmatter `host:` + lint | — | 別冊 §5 |
| (17) | A 今は出さない | — | 別冊 §4.3 |
| (18) | A PR マージのまま + 新ラインも追従・マーカー必須 | — | 別冊 §7 |
| (19) | A 含めない | 「リリースノートを含めるか？ということですよね。githubに集約してればいいのでは？」 | 別冊 §6.5 のまま。(19) はリリースノートではなく**同梱文書の更新経路**の問い。リリースノートは GitHub Releases を正本にし、(5) の自動更新が表示する更新内容もそこから取る |
| (20) | A 段落は今・主語は A-parity 後（owner の条件つき） | 「ただしVScode版と情報は分けてあげる必要があるでしょう。OrbitStudioで現状のOrbitScoreに間違った情報が混入することは避けたい。どこかでVSIXは退役させますが、それまではVSIXが使われているはずなので。」 | 🔴 条件: **拡張版の読者が OrbitStudio の記述を自分の手順として読まない**こと（拡張版を退役させるまで）。別冊 §3.4 の併記の書き方をこの条件で見直す（未着手） |
| (21) | A 写す（`docs/development/DOCS_SYNC_ROUTINE.md`） | — | 別冊 §10 |
| (24) | A 共有する | 「共有するでいいと思いますが、いわゆる@importのように明示的に関連性を示すものもあります。今後よりプログラマブルにDSLを描けるようにしていくことを考慮してください。」 | (24) のまま。B（document ごとに分ける）を考え直す引き金に「`@import` のような明示的な関連」と「よりプログラマブルな DSL」を加える |
| (25) | (a) A しない（再評価ボタン）/ (b) A 通知に 1 行 + 失われた一覧 | 「ソフトが落ちが時に自動復帰するか？という質問ですよね？だとしたら状態は復帰するが、実行は復帰しない、でいいと思っています。」 | F-12 のまま。owner の原則「**状態は復帰するが、実行は復帰しない**」は文面どおり**アプリ全体の再起動**にも当てはめる（document は戻すが、評価も再生もしない）。改訂（10-26 第 2 回の反映時）: 同じ原則から、F-12 の **session の再起動そのものは自動**にした（状態の復帰。ボタンで待つと LLM が締め出される・D-12）。再評価はボタンのまま |
| 4.4.0 の Origin | A issue を 1 本（daemon・engine 線） | — | **#996** に起票（§4.7 末尾） |

**第 1 回で説明を求められた 7 件**（→ 第 2 回で全件を裁定した。下の「第 2 回」の表）:

| # | owner の意見（原文・第 1 回） |
|---|---|
| §4.7 の反転 | 「基本はローカルのLLMから使うためのものなので、トークンが切れるとかでライブ中に使えなくなるとかがあると困る。その上でもう一度ベストプラクティスを再考してください。」 |
| §4.5.1 の写し | 「これはDSLをどこが責任を持つのかということですか？」 |
| (23) | 「これはMCPをネットに公開するか？という話？それをやる時はOrbitServerみたいな別の何かになると思うOrbitStudioはあくまでもOrbitScoreのVSIX版での制約や動作を改善するためにMacOSネイティブなローカルソフト（Abletonなど他のDAWと同じく）であります。」 |
| (22) | 「DSLの評価にはまだバグ的な振る舞いがあるので、行単位、ブロック単位、意味単位などより良い評価が行われるようにしてほしい。特に@importで複数ファイルにまたがっている場合などはより複雑な評価が必要になるはず。」 |
| (3) | 「Nodeにこだわりはない。ここでいうNodeは何を処理するためのNodeを指していますか？」 |
| (7) | 「ネイティブ版としてふさわしい形をしっかり考えてみて。」 |
| (9) | 「プロトコルのライセンスと花ですか？ここでいうプロトコルとは具体的に何を指していますか？」 |

**全体への意見**（原文）: 「VSIX版にあまり引っ張られることなくmacOSネイティブOrbitStudioとして仕切り直しをしてしっかりとした良いものを作っていきたい。OrbitScore DSLはライブコーディングのみならず作曲や音楽の分析、音のタイミングの分析など多岐に渡った使い方がされている。最近では人間＋LLMという音楽作品の共通のブリッジ役としても使われている(Who conducts the machine）。今後もこういった方向で伸ばしていくので、過去の資産が後々邪魔をすることがないようにしてほしい。」 — 本書の背骨（拡張版とのパリティ）との関係は、第 2 回の項目 1（パリティの再定義）で裁定した。

**第 2 回 — 裁定済み**（2026-10-26。第 1 回で説明を求められた 7 件を問いの意味から書き直し、全体への意見から出た問いを先頭に足した。各項目の「提案」と「main の意見」が owner の承認した内容）:

| # | 問い | 裁定 | owner の意見（原文） | 本書への反映 |
|---|---|---|---|---|
| 1 | 拡張版とのパリティを「関門」にするか「参照」にするか（全体への意見から） | **提案どおり**: 関門（守る）= 同じ DSL のコードが同じ音・同じ結果（キャプチャ WAV の判定を含む実機テスト）・能力が減らない / 関門（v1 だけ）= MCP ツールの名前・引数・戻り / 参照（作り直してよい）= 評価の区切り方・画面・パネル・コマンドの構成・ログの文言 / 引き継がない = 拡張版の通信方式から来た制約（例: `document_path` の改行禁止）・VS Code 固有の表面 | 「うん、DSLが実行された結果はVSIXと同じにならないといけないね。」 | §1.1・§1.2 D-1 / D-2・§5.3（冒頭の表）・§5.3.1（改行禁止を写さない）・§6.1・§7.4・§10 |
| 2 | 評価の受付口をアプリへどう移すか（第 1 回の §4.5.1） | **A 段階を分ける**: 層 2 へ移す時はいまと同じ区切り方の受付口（足場）をアプリのコードとして書き（結果は構造化した値）、凍結版との差分テストで一致を確かめる。新しい評価のかたち（項目 3）は独立した PR で入れ、その時点で差分テストを「違いを記録する検査」に書き換える | 「ただし段階を分けて移行する場合には、ちゃんと忘れずに最後まで移行をするように。こういうのって動いて安心して終わってしまうことがあるので。そういう視点で再考してみて。」 | §4.5.1（段階 1 / 段階 2）・**§1.4 暫定物の台帳**・D-11・§11 |
| 3 | 新しい評価のかたちを別の設計として起こす（第 1 回の (22)） | **提案どおり**: `session.evaluate` の要求に「どの文書のどの範囲か」を載せる（省略可能）。評価のかたちは別の設計 → **#997**（main が起票済み） | — | §5.3.1（`target`）・§5.3.6・§5.5・§14.1 (22) を閉じた |
| 4 | 鍵の検査と、LLM の繋ぎ方（第 1 回の §4.7 の反転と (23)） | (a) **鍵の検査を残す** / (b) **中継を同梱する**（`.app` に同梱した小さな中継を Claude Code に 1 回だけ登録し、stdio で話す。アプリを立ち上げ直しても登録はそのまま） | — | §4.4・§4.7・§5.2・§6・§10.2・§12（F-12〜F-17）・§13・D-10・D-12・§14.1 (23) を閉じた。🔴 **中継の具体は裁定 4 の範囲内の実装の選択**として、セキュリティの再検討（2026-10-26）の推奨 (a-ii) で書いた。裁定シートの説明文（「0600 の発見ファイルから最新のポートと鍵を読み、層 2 の TCP の `/mcp` に繋ぐ」）からの差は 3 点: (1) 中継は層 2 へ **UDS** で繋ぐ（0700 の `run/` + 0600 のソケット・発見ファイルは置かない）(2) **TCP の `/mcp` を v1 で開かない** (3) TCP の `/rpc`（WebView 専用）で **Origin の欠落も拒否**する。中継が `initialize` / `tools/list` を自分で答えること、TCP の `/rpc` にトークンを残すことを含めて、**main が 2026-10-26 に会話で owner へ説明済み。異論があれば戻す**（戻す時に変わるのは中継の上流と D-10 の (3)(4) だけで、RL-1〜RL-8 と D-12 は変わらない） |
| 5 | (3) Node を `.app` に同梱するか | **A 同梱** | 「これは質問２にも関係してると思います。nodeで評価する形にこだわっていません。より早く正確に処理されるならその方が望ましいです。特にタイミングなどの制御があるので。なので、そこも考慮してください。」 | §4.3・**§4.6 を書き直した**（T-1 と判断の規則）・§9 のまま |
| 6 | (7) 拡張版を新しい層 2 の窓口に書き直すか | **書き直さない**（凍結のまま退役まで保つ。他のエディタから繋ぐ日は、公開したプロトコルに繋ぐ一般の窓口として作る） | — | §0b・§3・§10・§11 |
| 7 | (9) プロトコルの定義のライセンス | **定義だけ Apache-2.0** | 「そういう意味ではDSLもApache-2.0でいいと思います。」 | §5.8・§8（`protocol/LICENSE` を S-rpc の N1-a1 で足す）。owner の意見の「DSL」の**範囲 = 仕様書（文法と意味の文書）だけ・#998**（owner 確定 2026-10-26。実装 `packages/engine` はルートのライセンスのまま）。本書は記録だけで、他のライセンスの記述は変えない |

**第 2 回の全体への意見**（原文）: 「可能ならこのあと出国する前にクラウドで一旦全通しくらいのつもりで作業を進めてもらって、帰国後に一緒にそれを確認できると有意義ですよね。」 → 計画 §7（クラウドに続けて渡せる順の作業列）。

**第 2 回の後に owner / main に確かめること**（本書は推奨で書いた。決まったら本節に記録する）:

| # | 何を | 本書での扱い |
|---|---|---|
| Q-r2-1 | 「v1」の範囲 = **第 1 リリース（🚪）まで**と読んだ（MCP ツールの関門・§6.1） | `MCP_V1_GATE_UNTIL` = 第 1 リリースの版（R-app の N4-a で `VERSION` を決める PR で入れる） |
| Q-r2-2 | T-1 の判断の閾値「m1 の p99 ≤ m0 の p99 + 64 フレーム」（§4.6） | 提案値。台帳 P-08 の置き値として扱い、T-1 の報告と一緒に main が確かめる |
| Q-r2-3 | #996（daemon の Origin と親の死）に `release-gate` を付けるか | 推奨: 付ける（台帳 P-05）。付けるのは main |

### 14.1 裁定前の表（2026-10-23 時点の推奨・14.0 で裁定したものも記録として残す）

| # | 問い | 選択肢 | 推奨と理由 |
|---|---|---|---|
| (1) | **detach**（アプリを閉じてもセッションを残す・§4.2 C）を第 1 リリースに含めるか | A 含めない（B のまま）/ B 含める（発見機構を設計） | **A**。B → C は後から足せる。孤児クラスを第 1 リリースに持ち込まない。LLM 単独は headless host で満たす（D-3） |
| (2) | `packages/engine` を rename するか（裁定 §3 のレイアウト案は `packages/session` への rename） | A しない（`session` を新設・`engine` は DSL ライブラリ）/ B rename | **A**。凍結版のビルド経路を触らない。曖昧さは `session` の新設で解ける |
| (3) | **Node 同梱**をアプリ線で採るか（改訂: W-22 の「引き継ぎ」ではない — 拡張側は #878 で VS Code 同梱の Node に乗り、この問いから外れた） | A 同梱 / B PATH の node に依存 / C Bun | **A**。D-7（cold-install で PATH の node が無くても動く）の唯一の解。B は #878 が潰した理由（Finder 起動の PATH は `/etc/paths` の最小構成）がそのままアプリにも掛かる。C は N-API 未検証。→ ✅ **10-26 第 2 回: A**（§14.0 の 5・タイミングは §4.6） |
| (4) | タグ名前空間とワークフロー分割 | `ext-v*` / `app-v*` + `release-app.yml`（裁定 §2.7 の案） | **案どおり**。§12.7 で未決と明記されている |
| (5) | 自動更新（Sparkle 等）を第 1 リリースに含めるか | A 含めない / B 含める | **A**。署名・公証・cold-install を先に通す |
| (6) | Swift の CI | A tag 時のみ + 手元ゲート / B per-PR macOS ランナー | **A**（owner の既定方針・コスト） |
| (7) | 凍結後、拡張を新 RPC の**薄いクライアント**に書き換えるか（§3 の「クライアント 3 つ」を完成させる） | A 別 issue として保留 / B 新ラインの計画に入れる | **A**。凍結（裁定 2.5）に反するので、owner が明示する時だけ。→ ✅ **10-26 第 2 回: 書き直さない**（§14.0 の 6・§10） |
| (8) | エディタクライアントを同時に複数許すか | A 1 つまで / B 複数（`open_file` の宛先規則が要る） | **A** |
| (9) | `protocol/` のライセンス（裁定 §5 の事務: 素の Apache-2.0 か MIT か） | — | owner。プロトコルが公開契約になる前が最も安い。→ ✅ **10-26 第 2 回: 定義だけ Apache-2.0**（§14.0 の 7・§5.8） |
| (10) | `.app` の bundle id・配布物名・アプリ名（「OrbitStudio」は候補名・`POST_2.0_ORBITSTUDIO_PLAN.md` owner 決定事項 8） | bundle id: A `com.signalcompose.orbitstudio`（VSCodium 版 Phase 2 で一度使われた id・Serena `orbitstudio_phase2_spike_2026-07-07`）を**そのまま使う** / B 新しい id | owner。**初回署名前に確定**（656 §5.2 一方通行）。推奨 **A**（VSCodium 版は配布されていないので衝突する既存インストールは無く、名前を増やさない） |
| (14) | **app の版の正本**（656 §4.4「拡張の `version` が正本」は app 版 = 拡張版 が崩れて**失効**・§9.0） | A `apps/OrbitStudio/VERSION` 1 ファイルを正本にし、`make-bundle.sh` が `Info.plist` へ写し、preflight で `app-v<版>` = tag を強制（656 §4.4 と同じ形）/ B `packages/session/package.json` の `version` を正本に / C ルート `package.json` | **A**。版は「ユーザーが手にする `.app`」の軸で、session や engine の内部版（`ENGINE_VERSION` / `DSL_VERSION`）とは別軸（656 §4.4 の別軸規則を引き継ぐ） |
| (11) | パリティ台帳で **not-applicable にしてよい拡張の表面**: `reloadWindow` / `openWalkthrough` / Learning view の範囲 / `startEngineDebug` の表面 / 改訂（10-23）: 登録のみのコマンド `showCommands`（ステータスバーの click → コマンドの QuickPick） | 各項目に「落とす / 置き換える」 | 推奨: `reloadWindow` 落とす（VS Code 固有）/ `openWalkthrough` 落とす（Docs パネルで代替）/ Learning view は Docs パネルに統合 / `startEngineDebug` は環境設定のトグルへ / `showCommands` 落とす（メニューバーが同じ役目・§5.3.7） |
| (12) | #848 本文の出力先は `docs/design/847-…` だがブリーフは `848-…` | — | 本書は **848** で置いた。issue 本文の修正は main。✅ 改訂（10-26）: **解消済み** — #848 の本文に `847` は 0 件（`gh issue view 848 --json body` を 2026-10-26 に確認） |
| (13) | 新ラインの**リリースゲート**に「ラック（#635 / #636 / #669）」を含める（裁定 §12.2「過去裁定『ラックはリリースの前提』は新ラインに対して生きる」）ことの再確認 | — | **含める**前提で地図を書いた。外すなら owner |
| (15)（改訂・別冊 §6.1） | **アプリに同梱する文書の範囲** | A user サイト（ja + en）+ DSL 仕様（`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`）/ B A + dev サイト / C user サイトのみ | **A**。LLM が要るのは「何を書けばどう鳴るか」と正本の仕様。dev サイトは 1.19 MB・引用が `path:line` でソース前提・読者が開発者なので、アプリ利用者の LLM には要らない。dev サイトは `get_dev_doc` の互換のために `--docs-dir` の追加ディレクトリとして**後から足せる**形にする |
| (16)（別冊 §5） | **可用性表記の形** | A 固定文法の 1 行（`> **対応**: 拡張版 4.2.0 以降 / OrbitStudio 0.1.0 以降`）+ frontmatter `host:` / B VitePress の custom container（`::: availability`）/ C 別ページの互換性表 | **A**。grep で検算でき（版の掃除で 4 回連続取りこぼした実績 `WORK_LOG.md` 4.2.0 節への答え）、LLM は本文中で読み、VitePress の設定を触らない。C は main の見立てどおり読まれる保証が無い |
| (17)（別冊 §4.3） | **凍結版の読者向けに 4.2.0 タグ時点の user サイトを静的スナップショットとして別パス（`/orbitscore/ext/`）で配信するか** | A 今は出さない（マーカーだけ）/ B 出す（`deploy-sites.yml` にタグ checkout のジョブ + `base` を env 化） | **A**。マーカーで足りる。B は**後から足せて戻れる**ので今決めなくてよい。凍結版の bug fix リリースが実際に出た時に再検討 |
| (18)（別冊 §7） | **docs 追従ルーチンのトリガー**と、main が 2026-09-18 に暫定追記した「新ライン = 追従対象外」「出荷済みの拡張版についてだけ書く」 | A PR マージのまま + 新ラインの PR も追従し「未リリース（OrbitStudio）」マーカー必須（暫定行は撤回）/ B owner 案 = リリース公開トリガー / C 暫定行のまま（新ラインは追従しない） | **A**。B は同梱物が構造的に 1 版古くなり、複数 PR の差分を 1 回で読むので取りこぼす（main の見立てに同意）。C は engine 線の束（O-multiout・ラック）が main に入っても文書化されず、アプリのリリース時に**まとめて書く**ことになり B と同じ取りこぼしを別の形で作る。🔴 暫定行は**前提条件つきで残す**なら「A-parity まで」と書く（memory `interim-markers-need-their-precondition`） |
| (19)（別冊 §6.5） | **リリース後の文書更新をアプリに届ける経路**を v1 に含めるか | A 含めない（1 リリース遅れを許容・manifest の `commit` で古さが分かる）/ B `--docs-dir` の上書きディレクトリ（`~/Library/Application Support/OrbitStudio/docs/`）を v1 で有効化 / C online 取得 | **A**。B は `--docs-dir` の解決順に 1 行足すだけなので設計には置くが、配る手段（zip の署名・入手経路）が無いうちは表面にしない。C は「ローカル LLM に読ませる」前提（オフライン）と噛み合わない |
| (20)（別冊 §3.4） | user サイトの**主語**（「VS Code の上で」`index.md:8` 等）と host 依存**段落**（`live-coding.md:14` / `instrument.md:37` / `effects.md:59` / `routing.md:145` ほか）を**いつ**直すか | A 段落は今（マーカー付きで両版を併記）・主語は A-parity 後 / B 全部 A-parity 後 / C 今すぐ全面 | **A**。段落は「拡張版: コマンドパレット / OrbitStudio: Catalog パネル」と併記しても DSL の記述を二重化しない。主語はアプリの表面が確定してから |
| (21)（別冊 §10） | ルーチンの手順本文をリポジトリ内に写すか（番号は別冊で振った） | 別冊 §10 | 別冊 §10 の推奨 A |
| **(22)**（10-23・#987 Q2） | **評価の単位**: 1 回の `session.evaluate` を**行ごとにパース・実行**するか（凍結版と同じ・今の既定）、**1 要求 = 1 パース**にして 1 か所でも構文エラーがあれば何も実行しないか | A 行ごと（凍結版と同じ）/ B 1 要求 = 1 パース（#987 B′ と設計 694 PR-L2 の前提） | **wire は A でも B でも同じ形**なので v1 の wire には焼かない（§5.3.1）。**ネイティブ線の推奨は「S-rpc / S-mcp では A のまま」**: B は評価の意味を変える（#987 Q2 の本文）ので、層 2 への移行と同じ束で変えると「移行で音が変わったか」を golden で問えなくなる（計画 §2.2 の検算の機会）。owner が #987 で B を採るなら、S-mcp の後の独立した PR で層 2 の写しを変え、§4.5.1 の差分テストの期待値（凍結版との差）を同じ PR で書き換える。凍結版も変えるか（#987 Q8 の例外）は #987 の裁定に従う。→ ✅ **10-26 第 2 回で閉じた**: 2 択では狭すぎたので、評価のかたちは **#997** の別の設計で決める。移行は段階を分ける（§4.5.1）。要求には `target` を載せる（§5.3.1） |
| **(23)**（10-23） | **LLM クライアントへのトークンの渡し方**（§4.7 でトークンを必須にした帰結）。Claude Code の `.mcp.json`（project スコープ）は**バージョン管理で共有される**（Claude Code の MCP の文書） | A `session.registerMcp` はトークンがある時 **project スコープを拒否**し、**local スコープ**（`~/.claude.json`）を既定にして `Authorization: Bearer` のヘッダを書く / B LLM が **stdio** で繋ぐ経路を用意する（`orbitscore session --mcp-stdio` で LLM が自分の headless session を持つ、または 0600 のトークンファイルを読んでアプリの session へ中継する薄いプロセス。MCP 仕様 2025-11-25 は「clients SHOULD support stdio whenever possible」）/ C `.mcp.json` の `${VAR}` 展開でトークンを環境変数から読ませる | **A を v1 の既定 + B を設計に置く**（実装は要るようになってから）。理由: A はトークンをリポジトリに入れない最小の変更で、`register_mcp_server` の契約（`scope` 引数）をそのまま使える。ただしトークンは session の起動ごとに変わる（ポートも ephemeral なら変わる）ので、**登録は起動のたびに書き直す必要がある** — その運用が重ければ B（stdio はネットワークの露出も無い）。C は利用者に環境変数の管理を求めるので v1 の既定にしない。→ ✅ **10-26 第 2 回で閉じた**: 推奨 A の「登録は起動のたびに書き直す」は、owner の懸念（ライブ中に締め出される）の穴そのものだった。**同梱の中継を 1 回だけ登録する**（§14.0 の 4・§4.7・§6）。owner の問い「MCPをネットに公開するか？という話？」への答えは「違う」— 同じ Mac の LLM クライアントに秘密をどう渡すかの問いだった |
| **(24)**（10-23・低優先） | **`.orbs` を 2 つ開いた時**、両方が同じ global 名前空間とトランスポートを共有するか | A 共有する（拡張版と同じ。1 session に全 document）/ B document ごとに分ける | **A**。理由: 拡張版と同じ（パリティ）で、「1 host = 1 session = 1 daemon」（§4.4）と整合する。分けると document ごとに session と daemon が立ち、出力デバイスの取り合い（#624 のクラス）を持ち込む。参照: SC は全文書が 1 つのインタプリタを共有し、Bitwig は複数のプロジェクトを開けるがエンジンを持てるのは 1 つ（調査 B-5）。B を考えるのは import が生む「プロジェクト」の概念（memory `orbitscore-language-vision-import-project`）が入った時 |
| **(25)**（10-23・F-12） | 層 2 だけが落ちて再起動した後の振る舞い: (a) **自動で再評価するか**（音は再評価しないと戻らない）(b) **テキストの外にあるプラグインの状態**（`plugin.saveState` で保存していない分）が失われたことをどう伝えるか | (a) A しない（通知に「前面の document を再評価」ボタンを並べる）/ B 前面の document を自動で再評価 / C 開いている全 document を自動で再評価。(b) A 通知に 1 行 + 失われた `(receiver,index)` の一覧 / B 伝えない | (a) **A**: 再評価は transport の命令（`LOOP` / `RUN`）を含みうるので、利用者の操作なしに音を出さない。再起動と再評価はボタン 2 つ・モーダル無しで、D-5（評価経路に確認を挟まない）とも両立する。(b) **A**: 黙らない（#385 型の沈黙を作らない）。一覧はアプリが最後に受けた `engine.state` から作り、取れなければ「一覧は不明」と書く |

---

## 15. 裁定済み事項に対する提案（実装しない・報告のみ）

| 対象 | 提案 | 理由 |
|---|---|---|
| 裁定 §3「MIDI スケジューラと transport だけ先に Rust へ」 | 順序を「§9 の実測 → 差が聞こえたら PR-Q の `ScheduleEvents` に乗せる」に固定する | 聞こえない差に払わない（§4.6）。受け皿は既に doc 428 にある。改訂（10-26）: 提案ではなく本文の規則にした — T-1（N0-d）と判断の規則（§4.6・台帳 P-06） |
| 裁定 §3「`CLAUDE.md` を層ごとに配置」 | 中身は「置かないもの」だけにする（§8） | 置くものを書くと地図と二重になる |
| 裁定 §12.7 (6)「Phase 1（層 2 抽出）→ Phase 2 spike を並行」 | spike（N0）を**先に**置く。層 2 抽出は spike の結果に依存しないが、spike が崩れた時の戻り先（Electron）で層 2 の transport（WebSocket）は変わらないので並行でよい — ただし **IME の判定だけは最初に**（崩れると全体が変わる） | §1.3 |
| #757（bridge の重複） | 改訂（10-23）: ✅ **凍結版で実装して CLOSED**（共通骨格 `correlated-line-bridge.ts` + 5 本・PR #985・2026-10-23）。新ラインでは wire の request id で骨格ごと不要（§3） | 旧版の提案「凍結版では触らない」は、4.4.0 の束で凍結版を触って閉じたので失効した。新ラインへの影響は無い（「消える」量が 1,499 → 1,437 行になっただけ・§3.1） |
| 裁定 §12.7 (4)「README を導線へ」/ §10.3 初版「user サイトをアプリ主語へ」 | user サイトの主語は**書き換えない**。host 依存の段落だけ併記し、機能は可用性表記で分ける（別冊） | 拡張版は将来メンテの可能性が残る（owner 要件 2026-09-18）。主語を替えると凍結版の読者向け記述を失う |

---

## 16. 改訂履歴

| 日付 | 内容 |
|---|---|
| 2026-09-11 | 初版（#848・Fable 起案・effort xhigh）。`origin/848-native-design` `1bd65b80` |
| 2026-09-18 | 改訂（Fable・effort high）。§2 を main `1276ab1f` で再測し §2b の判定表を新設。崩れた結論: §3「19 本そのまま」→ §3.1 の 3 分類表 / §9「PATH の node」→ #878 の Electron 同梱 Node（アプリ線だけに同梱の判断が残る）/ §9.1 `docs/` の中身が未設計 → 別冊 `848-docs-structure-design.md`。追加: D-9・F-11・§5.3 の 2 行・§7.4 の 1 行・§14 (15)〜(20)。用語「OrbitStudio = ネイティブ版」を固定 |
| 2026-10-23 | 改訂（起案: fresh subagent / 審査: main）。§2 を main `7410dcb0`（拡張 4.4.0）で再測し、比較元 `1276ab1f` の日付を 09-14（4.2.0 マージ）に訂正、§2c の判定表を新設。🔴 **セキュリティの結論を反転**: 「認証を付けない」を撤回し `/rpc` と `/mcp` にトークン + Origin（§4.7 の脅威モデル・層 1 は engine 線へ申し送り）。**プロトコルの形を確定**: §5.3 を現行表面の全写像に作り直し（ツール 28・メタ行 8・stdout 4 系統・コマンド 19・HTTP 4・環境変数。漏れ L1〜L11）、`session.evaluate` は状態を持たない（`documentDirectory` 毎回必須・`evalId` をサーバが振る）、`transport.step` に `source`、`log.line` に `level` / `kind`、`docs.*` に `site` / `limit`、`engine.start` に `hostBundleId`、評価の単位は wire に焼かず実装の既定は凍結版と同じ。§4.4 に F-1 の機構（stdin の EOF + 親 PID）、§4.5.1 に層 2 が engine を呼ぶ入口（写し + 差分テスト）、§4.5.2 にネイティブ版のワークスペース、§6 に `tools/list` の順序の契約、§7.3 に WebView の配信元（`/app/` が本命・`file://` は代替ではない）、§10.2 にハーネスがトークンを知る経路。完了条件: D-1（v4.4.0・56 `it`・基準タグ `PARITY_BASELINE_TAG`）/ D-6（再現手順と Monaco の版の固定）/ D-9（4.2.1 の同梱を引き継ぐ）を書き換え、D-10（接続の認証）を追加。F-12 / F-13 を追加。§14 に (22)〜(25)。入力: 再測（`7410dcb0`）・外部参照の調査（2026-10-23）・#987 の設計（`origin/claude/sweet-pasteur-2l1eef`） |
| 2026-10-26 | owner 裁定を反映（審査: main。起案なし — 裁定の記録と直接の帰結だけ）。§14.0 を新設し、裁定済み 20 件・説明待ち 7 件・全体への意見を原文で記録。(5) 自動更新は **B（含める）** に転じたので §9.3 を改訂。(6) の条件を §9.4、(8) の「1 クライアント = 複数 document」を §5.4、4.4.0 の Origin の issue（#996）を §4.7 に反映。§4.7 の反転・§4.5.1・(22)・(23)・(3)・(7)・(9) は**まだ決まっていない** |
| 2026-10-26（第 2 回） | 改訂（起案: fresh subagent / 審査: main・起点 `042906b9`）。owner 裁定 第 2 回（7 件 + 全体への意見）を反映し、§14.0 に原文と反映先を記録。(1) **パリティの再定義**: 関門 = 「DSL が実行された結果は拡張版と同じ」+ 能力 / MCP ツールは v1 だけ関門（§6.1・`mcp-tools-v1.spec.ts` が `VERSION` で自動で外れる）/ 拡張版は回帰の検算台（§1.1・D-1 の分類の規則・D-2・§5.3 冒頭・§7.4・§10）/ `document_path` の改行禁止は写さない。(2) **§4.5.1 を段階 1（足場）/ 段階 2（#997・S-eval）に**し、**§1.4 暫定物の台帳**（18 行・印 `PROVISIONAL(P-xx)`・期限 4 種・release モード）と **D-11** を新設。4 ファイルの列挙 134 行に処分を付けた（§1.4.3）。新しく見つけた暫定物: engine の console 出力（P-07）・Monaco のパッチ（P-17）・`protocol:check` が TS 側だけ（P-18）。(3) `session.evaluate` に省略可能な **`target`**（§5.3.1）。(4) **中継**: セキュリティの再検討（2026-10-26）の推奨で、中継 = MCP サーバ・層 2 へは UDS・TCP の `/mcp` は v1 で開かない・TCP の `/rpc` は Origin の欠落も拒否（§4.4・§4.7・§4.7.1・§5.2・§5.3.8・§5.3.9・§6・§6.2・§6.3・§10.2・F-12・F-13・D-10 を書き直し・F-14〜F-17 と **D-12** を新設）。裁定シートの説明文（発見ファイル + `/mcp`）との差 3 点は §14.0 に「裁定 4 の範囲内の実装の選択・main が owner へ説明済み」として記録。裁定 7 の DSL の範囲 = 仕様書だけ・#998 を記録。F-12 の session の再起動を自動に（状態の復帰）。(5) **§4.6 を書き直し**: T-1（N0-d）と判断の規則（m1 の p99 > m0 の p99 + 64 フレームなら PR-Q をゲートへ・提案値）。(6)(7) 拡張版は書き直さない / `protocol/` は Apache-2.0（§5.8・§8）。§2d に判定表。§14.1 (3)(7)(9)(12)(22)(23) を閉じた |
