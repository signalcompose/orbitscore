# 実装プラン（ネイティブ版）— 段・束・受け入れ基準（#848）

**状態**: 計画（実装しない）・2026-09-11・main `229d6387` 起点
**前提**: [`848-native-orbitstudio-design.md`](../design/848-native-orbitstudio-design.md)（設計・完了条件 §1.2）/ [`NATIVE_MIGRATION_2026-09.md`](NATIVE_MIGRATION_2026-09.md) §12（裁定）/ [`NATIVE_DEVELOPMENT_MAP.md`](NATIVE_DEVELOPMENT_MAP.md)（地図）/ [`BUNDLE_BRANCH_WORKFLOW.md`](../development/BUNDLE_BRANCH_WORKFLOW.md) / `PROJECT_RULES.md` §1b-§1d / CLAUDE.md「テストの積み上げ規律」（① 仕様 → ② MCP 経由 E2E → ③ 機能テスト → ④ 変異は最後の手段）
**既存の検討との関係**: 設計 §0b（引き継ぐ / 棄却 / 失効の仕分け）が正本。配布は `656-release-design.md` を再設計せず**差分だけ**（設計 §9.0）。
**引き継がないもの**: [`IMPLEMENTATION_PLAN_2026-09.md`](IMPLEMENTATION_PLAN_2026-09.md) は**拡張版**の計画。本プランはそれを引き継がない。ただし裁定 §12.3「ステージ 3〜7 は層 1 / 2 の作業なのでそのまま生きる」に従い、**engine 側の PR（PR-L / R / K / Q / P / V / D）は旧計画を番号でポインタ参照**し、本プランでは**拡張側に触る行だけを付け替える**（§4）。

> 🔴 **各 PR の共通規約**（CLAUDE.md・PROJECT_RULES）: 1 PR = 1 論理変更・各 commit で build + test 緑・spec を先に直す・DSL 表面を足したら gated E2E を足す（ラチェット）・capture するなら数値で判定・`ok` に assert しない・ERROR 件数は `<=`・変異テストは PR に載せない・横断的関心事は先にポリシー 1 段落。
> 🔴 **束の数え方は変更行（`+` と `-` の合計）**。1,500 行以下。上限より先に「検算の機会」で切る（§2.2）。
> 🔴 **概算行数はすべて未実測**。束を開く時に測り直して本表を更新する（`BUNDLE_BRANCH_WORKFLOW.md` §5.1b「決めた瞬間に書く」）。

---

## 0. 🔴 一方通行の判断（先に洗い出す・戻せないもの）

| # | 判断 | どこで確定するか | 戻せない理由 | 裁定の状態 |
|---|---|---|---|---|
| N-1 | セッションプロトコル v1（JSON-RPC 2.0 over WebSocket・`/rpc`・逆方向 `editor.*`・通知）の**形** | 束 S-rpc | クライアント（WebView・headless・将来の拡張）が増えた後は変えにくい。同梱なので互換期間は不要だが**形**は残る | 設計 §5（起案）。**確定は束 S-rpc の締めのレビュー**で |
| N-2 | ディレクトリ `packages/session/` `apps/OrbitStudio/` `protocol/` の新設・`packages/engine` は rename しない | 束 S-rpc | パスは後から変えにくい | 設計 §8・§14 (2) 推奨 A |
| N-3 | `orbitscore session --port --mcp --docs-dir` の起動引数と ready 行の形 | 束 S-rpc | host（Swift・ハーネス）が依存 | 設計 §4.4 |
| N-4 | ハーネスの env `ORBIT_GATED_TARGET = vscode \| native \| headless`（既定 `vscode`） | 束 S-mcp | CI・手順書・memory が依存 | 設計 §10.2 |
| N-5 | パリティ台帳 `tests/e2e/native-parity-ledger.ts` の形（凍結タグ時点の `it` 題名を全列挙・分類必須） | 束 S-mcp | 増やす方向にしか編集できないラチェット | 設計 §1.2 D-1 |
| N-6 | スキーマの `x-surfaces` と `npm run protocol:check`（生成物をコミット） | 束 S-rpc | 生成物の置き場 | 設計 §5.8 |
| N-7 | Node を `.app` に同梱 | 束 R-app | 署名対象 +1・entitlements | 🔴 §14 (3)・W-22 の引き継ぎ確認 |
| N-8 | `.app` の bundle id・アプリ名・配布物名・署名 Team ID | 束 R-app（**初回署名の前**） | macOS 上で別アプリになる（656 §5.2） | 🔴 §14 (10) |
| N-9 | タグ名前空間 `app-v*` / `ext-v*`・`release-app.yml` | 束 R-app | リリース手順 | 🔴 §14 (4) |
| N-10 | 拡張（凍結）を新 RPC の薄いクライアントにするか | 着手しない | 凍結違反 | 🔴 §14 (7)・別 issue |
| N-11 | **app の版の正本**（656 §4.4「拡張の `version`」は失効・設計 §9.0） | 束 R-app（preflight） | 利用者の更新経路と Releases の版履歴に焼き付く | 🔴 §14 (14)・推奨 A（`apps/OrbitStudio/VERSION`） |
| N-12 | ハーネスの `ORBIT_GATED_APP_PATH`（656 §6.2 の `ORBIT_GATED_EXT_MODE=installed` の後継） | 束 A-skeleton | 手順書が依存 | 設計 §10.2 |

**方針**: 一方通行は **(a) 束の先頭か単独に置き**、**(b) 消費者が 0 のうちに確定し**（N-1〜N-3 は S-rpc の時点で消費者はテストだけ）、**(c) owner 裁定待ちのものはその束だけが止まる**形に分割する（N-7〜N-9 は R-app にしか無い）。

---

## 1. 段（ステージ）と依存グラフ

```
                ┌──── アプリ線（本プランの本体） ─────────────────────────────────────────┐
                │                                                                          │
  N0 spike ──┬─→ N1 層 2 抽出 ──→ N2 walking skeleton ──→ N3 エディタ・パネルのパリティ ──→ N4 配布 ──→ 🚪 第 1 リリース
  (IME/schema │   S-rpc → S-mcp → S-editor    A-skeleton      A-document → A-panels → A-parity   R-app          │
   /sign)     │                                                                                                  │
              └─→（IME が崩れたら Electron 検討へ戻る・設計 §1.3。層 2 の transport は変わらないので N1 は止めない）
                                                                                                                 │
  ┌──── engine 線（層 1 / 2・旧計画の PR をポインタで・§4）───────────────────────────────────────────────────┤
  │  O-multiout（新ラインの最初の束・裁定 §12.3）→ L（ログ→リプレイ）→ R（render）→ V（可視化・性能）           │
  │  → Q/K（queue・PDC・layer・instrument rack・標準プラグイン = 🚪 ラック）→ P（プラグイン境界）                │
  └──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  🚪 第 1 リリースの条件 = N4 完了 ∧ K（ラック #635 / #636 / #669）完了（裁定 §12.2「ラックはリリースの前提」は新ラインに生きる・設計 §14 (13)）
```

矢印は「左が終わらないと右が**着手できない**」。**同じ行に並ぶものは順序を持たない**。アプリ線と engine 線は**独立**（ブランチも実機も共有しない・#848 本文）。engine 線の PR が拡張側に触る行は §4 で `packages/session` / `apps/OrbitStudio` へ付け替える。

### 何が何を塞ぐか（🔴 foundation 相当）

| 段 | 塞いでいるもの | 理由 |
|---|---|---|
| N0-a（Monaco + IME） | N2 以降の**全部**（崩れたら §1.3 の戻り） | 裁定 §9「最大の未知数」 |
| N1 S-rpc（プロトコル v1） | N1 S-mcp / S-editor・N2・headless | クライアントは全部これに乗る |
| N1 S-mcp（MCP を層 2 へ + headless ターゲット） | パリティ台帳（D-1）・D-3 | 台帳は headless で最初に走る |
| N2 A-skeleton | N3 全部 | skeleton が無いと表面を足せない |
| N4 R-app | 🚪 | 配布の一方通行 3 件（N-7〜N-9）は owner 裁定待ち |

---

## 2. 束の切り方

### 2.1 束の一覧（統合ブランチ・中身・概算・検証）

🔴 統合ブランチ名は **束ごとの issue を地図の節から起票してから**その番号で切る（地図 §0.2・PROJECT_RULES「ISSUE 番号のないブランチ名は禁止」）。起票までは `848-` を仮置きし、起票時に本表を更新する。

| 束 | 統合ブランチ（仮） | 中身（小 PR） | 概算（変更行・**未実測**） | 検証（束 PR で） | 🔴 ここで切る理由 |
|---|---|---|---|---|---|
| **N-spike** | `848-native-spike` | **N0-a** Swift + WKWebView + Monaco（`.orbs` ハイライト・⌘Enter・**IME**）/ **N0-b** `protocol/` の生成ツール選定（3 メッセージ往復）/ **N0-c** SwiftPM → `.app` 組み立て → 同梱 node 起動 → 署名（hardened runtime）で `spctl` 通過 | 約 900 | N0-a: **owner 実機確認**（IME・D-6）+ `file://` → `ws://127.0.0.1` の可否を記録 / N0-b: 生成物の往復テスト / N0-c: 署名済み skeleton が起動し node が走る（entitlements の実測表を `docs/research/` へ） | 結果が**設計の前提**（§1.3・§7.3・§9.2）を左右する。実装より先に、実装と混ぜずに |
| **S-rpc** 🔴 | `848-session-rpc` | **N1-a1** `protocol/session/v1` スキーマ + 生成 + `protocol:check` / **N1-a2** `packages/session` の WebSocket サーバ（handshake・attach・`session.evaluate`・`transport.step`・`log.line`・`session.getLog`）/ **N1-a3** `orbitscore session` CLI（ready 行・shutdown・daemon の畳み方） | 約 1,100 | unit（2 クライアント同時 attach・FIFO の順序・不一致 version の拒否）+ **実機**: headless で `session.evaluate` → capture RMS > 0 | 一方通行 N-1〜N-3・N-6 を**この束だけ**に閉じる |
| **S-mcp** 🔴 | `848-session-mcp` | **N1-b1** `mcp-server.ts` を `packages/session/src/mcp/` へ移動し handlers を層 2 の実装へ（`force_kill_scsynth` 無し）/ **N1-b2** ハーネスに `ORBIT_GATED_TARGET=headless` / **N1-b3** `native-parity-ledger.ts`（凍結タグの `it` 題名を全列挙・`needs-editor` 分類・未分類 red） | 約 900 | 🔴 **goldens が 1 つも動かないこと**（`OUTPUT_LINE_GOLDENS` / rack 期待値）を headless で + editor 非依存の題名が全件緑（D-3） | **振る舞いを変えない host の入れ替え**なので、検算は「goldens が動かないこと」。S-editor（振る舞いを足す）と同じ束に入れるとこの検算は失われる |
| **S-editor** | `848-session-editor` | **N1-c1** document 同期（`editor.didOpen/didChange/didClose/didChangeSelection`）と写し / **N1-c2** 診断・補完・subject-block を層 2 のサービスへ（`diagnostics-analysis.ts` / `plugin-name-diagnostics.ts` / `completion-context.ts` の vscode 依存除去 / `getLineSubject` の移動）/ **N1-c3** 逆方向 `editor.*` リクエストと `NO_EDITOR_ATTACHED` | 約 1,200 | unit（`editor.diagnostics` 通知と `get_diagnostics` の一致・subject-block の既存 unit を層 2 で再実行）+ 実機: headless で `open_file` が `NO_EDITOR_ATTACHED` を返す | 逆方向の契約（設計 §5.4）を単独で確かめる |
| **A-skeleton** 🔴 | `848-app-skeleton` | **N2-a** Swift シェル（1 ウィンドウ・WKWebView・session の spawn / 監視 / shutdown・⌘Enter）/ **N2-b** Web クライアント（Monaco + RPC クライアント + `playhead.ts` の decoration）/ **N2-c** ハーネスに `ORBIT_GATED_TARGET=native`（起動・PID オラクルの teardown） | 約 1,500（Swift 700 / TS 800・**上限に近い**。N0-a の Monaco 設定を持ち越して減らす） | 設計 §1.3 の 1〜5 + 🔴 **goldens が動かないこと**（native）+ IME（owner） | walking skeleton を**表面を足す前に**閉じる。裁定 §5 Phase 2「数週間で結論が出る想定」の単位 |
| **A-document** | `848-app-document` | **N3-a1** `NSDocument`（open / save / autosave / 未保存確認・バイト同一の往復）/ **N3-a2** タブ・メニュー・最近使った書類 / **N3-a3** 環境設定（設定 10 項目の写像・設計 §7.4） | 約 900 | 実機: `open_file` → `edit_replace` → `save_file` → ファイルが byte 一致（E2E）+ 自動保存の実機確認 | AppKit 標準機能の受け入れ。ライブ経路とは独立 |
| **A-panels** | `848-app-panels` | **N3-b1** Engine パネル（`engine-view.ts` の写像・デバイス選択・起動停止）/ **N3-b2** Log パネル + ステータス（`transport.state`）/ **N3-b3** Catalog パネル（rescan / browse）/ **N3-b4** Docs パネル / **N3-b5** flash と playhead palette | 約 1,000 | 実機: `select_audio_device` 後に capture RMS > 0（E-2 相当）/ `get_log` と Log パネルの行数一致 / `rescan_plugins` 後に Catalog に fixture が出る | 表面ごとに E2E が付く。D-4 の検査をここで初めて全面適用 |
| **A-parity** | `848-app-parity` | **N3-c1** 台帳の残り（`native-required` の全件緑）/ **N3-c2** `not-applicable` の owner 裁定を台帳へ（§14 (11)）/ **N3-c3** D-5（モーダル無し・50 回連続評価の分散）| 約 600 | **D-1 全件緑 + D-2 + D-3 + D-4 + D-5** | 完了条件の締め。ここを過ぎたら**拡張版に無い機能**を足してよい |
| **R-app** 🔴 | `848-release-app` | **N4-a** `make-local-release.sh`（app 版・656 §4.2 の 12 段を設計 §9.2 の対応表で差し替え・`verify-app.sh`・内側から署名 → dmg → notarize → staple）+ entitlements（N0-c の実測表から）/ **N4-b** `release-app.yml`（`app-v*` tag・macos-14・同じ 1 本を呼ぶ）/ **N4-c** cold-install E2E（`ORBIT_GATED_APP_PATH=<成果物>` で gated `native`・PATH を絞る・quarantine を明示的に付ける = 656 E2E-D3 の後継）/ **N4-d** docs（`CODESIGN_PIPELINE.md` 全面改訂・`installation.md`・656 §13 の引き継ぎ）| 約 900 | 別アカウントで `.dmg` → 音（D-7）+ `spctl --assess` + 署名済み `.app` で 3rd-party が鳴る（656 E2E-D4）+ `verify-app.sh` exit 0（656 E2E-D5 の後継） | 一方通行 N-7〜N-9・N-11 を**この束だけ**に閉じる。**owner 裁定が来るまで他の束は止まらない**。🔴 **656 を再設計しない** — 差分は設計 §9.0 の表 |

**main 直行**（束を通さない）: 本設計 3 本（docs）/ `CLAUDE.md` のマージ前ゲートに `swift build` を足す行（docs）/ N0 の spike レポート（`docs/research/`・docs）/ 凍結版への bug fix（従来どおり単独フルレビュー）。

### 2.2 「検算の機会」で切った箇所（`BUNDLE_BRANCH_WORKFLOW.md` §5.1）

1. **S-mcp を S-editor と分けた** — S-mcp は「拡張の MCP を層 2 に**移す**」だけで振る舞いを変えない。検算は「goldens が動かないこと」。S-editor は逆方向リクエストと診断サービスを**足す**ので goldens は正当に変わりうる（診断の件数）。同じ束にすると「移動で音が変わったか」を二度と問えない
2. **A-skeleton を A-document / A-panels と分けた** — skeleton は「アプリからも同じ音が出る」を goldens で確かめる最初で最後の機会。表面を足した後では、赤の帰属が「アプリの表面が誤り」と「配線が誤り」に割れる
3. **R-app を単独にした** — 配布の一方通行（bundle id・tag・node 同梱）は owner 裁定を待つ。他の束が裁定待ちで止まらないようにする

### 2.3 小 PR の軽いゲート（Swift を含む場合の追加）

`BUNDLE_BRANCH_WORKFLOW.md` §5.3 に加えて:

- **`swift build -c release`**（`apps/OrbitStudio/`）を無条件で回す。🔴 委譲先（Codex）の sandbox で `swift build` が通るかは **N0-a で最初に確かめる**（通らなければ Swift のコンパイル確認は main の仕事に固定し、本表に書く）
- **その PR が足した E2E だけを実機で**。🔴 native ターゲットも `-t` で絞れるのは自己完結テストだけ（CLAUDE.md）。絞れなければ全件（約 10 分・2026-09-10 の 528 秒が目安）
- 実機は**本ツリー**で回す（memory `worktrees-cannot-do-real-machine-verification`）。アプリの GUI 起動は他の実機作業（O-surface）と競合するので、**同時に走らせない**（memory `dont-build-during-gated-runs` と同じクラス）

---

## 3. 各段の受け入れ基準と、実機で確かめること

各段: **ユーザーに見える結果（1 文）** / **受け入れ（何が緑なら次へ）** / **🔴 実機で確かめること**（このプロジェクトはユニット緑では信用しない） / **閉じる**。**日程は書かない。**

### N0 — spike（束 N-spike）

- **結果**: 設計の 3 つの未検証（Monaco + IME / スキーマ生成 / 同梱 node の署名）に**実測の答え**が付き、設計 §13 の確信度が「低」から「高 or 反証」へ動く。
- **受け入れ**:
  - N0-a: WKWebView 上の Monaco で `.orbs` がハイライトされ、⌘Enter が JS 側に届き、**日本語 IME の変換・確定・未確定描画が動く**（owner 確認・日付と hash を `WORK_LOG`）。`file://` から `ws://127.0.0.1` へ繋がるかの実測（可否どちらでも設計は変わらない・§7.3）。TextMate 流用か Monarch かを 20 譜面のトークン列比較で決める
  - N0-b: `protocol/session/v1/` の 3 メッセージが TS ↔ Swift で往復して等しい。生成ツールを固定
  - N0-c: `Package.swift` → `make-bundle.sh` → `.app` に node を同梱 → hardened runtime で署名 → `spctl --assess` 通過 → node が `--version` を返す。**entitlements の実測表**（656 §5.3 の手順）を `docs/research/848-native-spike-report.md` に残す
- **🔴 実機**: 上の 3 つはすべて実機でしか答えが出ない。**Codex の sandbox では 1 つも走らない**（GUI・署名・キーチェーン）。main が回す。
- **閉じる**: 設計 §13 の該当行を更新。崩れた項目があれば**実装に進まず報告**（CLAUDE.md「Phase 0 の停止条件」と同じ扱い）。

### N1 — 層 2 の抽出（束 S-rpc → S-mcp → S-editor）

- **結果**: `orbitscore session --port 39123 --mcp` だけで、エディタ無しに LLM が今日と同じ MCP ツールでセッションを操作できる。拡張は**触っていない**。
- **受け入れ**:
  - S-rpc: unit（attach 2 件・FIFO・version 不一致の拒否・`session.evaluate` の 1 リクエスト = 1 `execute()`）+ 実機 headless で `session.evaluate` → capture RMS > 0
  - S-mcp: 🔴 **goldens が 1 つも動かない**（headless）+ 台帳の `needs-editor` 以外が全件緑（D-3）+ `get_log` の ERROR が `<=`
  - S-editor: `open_file` が headless で `NO_EDITOR_ATTACHED`（構造化エラー・黙らない）+ 診断の一致 unit
- **🔴 実機**: `npm run test:e2e:gated` を `ORBIT_GATED_TARGET=headless` で。daemon の台数（PID オラクル）が各 phase 境界で高々 1。`.orbslog` に `evalSource` / `clientId` が写る（人間 + LLM の交互評価を 1 本のログで）。
- **閉じる**: 設計 §5.3 の表の各行が実装済み（列挙表を PR 本文で `[x]` 化・PROJECT_RULES §1d）。**#757 は新ラインでは発生しない**ことを台帳に記録（凍結版では OPEN のまま）。

### N2 — walking skeleton（束 A-skeleton）

- **結果**: `OrbitStudio.app` を開き、`.orbs` を書いて ⌘Enter で音が出て playhead が動く。タブ・保存・設定は無い。
- **受け入れ**: 設計 §1.3 の 1〜5 + 🔴 **goldens が動かない**（native）+ **IME**（owner・D-6）+ ハーネス teardown で session / daemon が残らない（PID オラクル）。
- **🔴 実機**: `ORBIT_GATED_TARGET=native` で `open_file` → `run_selection` → capture RMS > 0 の 1 本 + goldens。WebView を強制リロードしても音が続く（層 2 が生き残る）。Swift 本体を SIGKILL して session / daemon が消える。
- **閉じる**: 裁定 §5 Phase 2。**崩れたら Electron 検討へ戻る**（§1.3）— その判断は owner。

### N3 — パリティ（束 A-document → A-panels → A-parity）

- **結果**: 凍結版の拡張でできたことが、アプリで**同じ MCP ツール名**で全部できる。
- **受け入れ**: A-document: 保存の byte 一致 E2E / A-panels: 各パネルに 1 本以上の E2E（設計 §7.4 の行ごと）/ A-parity: **D-1〜D-5 全部**。
- **🔴 実機**: `ORBIT_GATED_TARGET=native` 全件 + `get_log` ERROR `<=` + D-5 の 50 回連続評価 + プラグイン UI の開閉（child の `NSWindow`）が `open_plugin_ui` / `close_plugin_ui` で人手なしに動く。
- **閉じる**: 台帳の未分類 0・`native-required` 全緑。§14 (11) の裁定を台帳へ転記。

### N4 — 配布（束 R-app）

- **結果**: 署名・公証済み `OrbitStudio-<version>-darwin-arm64.dmg` が GitHub Releases に置かれ、新規環境で起動して音が出る。
- **受け入れ**: D-7 + `spctl --assess` + 656 E2E-D4（署名済み `.app` で 3rd-party が鳴る）+ tag で `release-app.yml` が 1 回通る。
- **🔴 実機**: 別の macOS アカウント（または別機）で `.dmg` から。**PATH に node が無い**状態で。quarantine を `xattr -w` で明示的に付けてから開く。
- **閉じる**: #656 / #659 / #138 を**ネイティブ app の配布として書き直した issue**（起票待ち・地図 §4.D）。

### 🚪 第 1 リリース

N4 完了 ∧ engine 線 K（ラック #635 / #636 / #669）完了。**凍結版 ≠ リリース**（裁定 §12.2）。リリースゲートの残り（`release-gate` ラベル）は旧地図 §3 の連鎖を新地図 §3 で引き継ぐ。

---

## 4. engine 線 — 旧計画の PR をどう扱うか（引き継がないが、ポインタは持つ）

裁定 §12.3「ステージ 3〜7 は層 1 / 2 の作業なのでそのまま生きる」。**PR の中身は旧計画（`IMPLEMENTATION_PLAN_2026-09.md` §1）が正本のまま**。本プランは次の 2 点だけを足す。

### 4.1 拡張側に触る行の付け替え（🔴 新ラインでは `extension.ts` / `repl-mode.ts` を触らない）

| 旧 PR | 旧計画で触る拡張側のファイル | 新ラインでの置き場 |
|---|---|---|
| PR-L1b `feat(extension): enable the session log from OrbitStudio` | `package.json` / `extension.ts`（env・`writeCodeToEngine` 3 引数） | `packages/session`（`session.evaluate` の `frame` と `.orbslog` writer の起動引数）+ アプリ環境設定。**`//#sourceFile` は wire 上に出ない**（`editor.didOpen` の `uri` が持つ） |
| PR-L2 `feat(repl): //#evalBegin / //#evalEnd frame` | `repl-mode.ts` / `extension.ts` | 🔴 **凍結線（O-surface）が依存するので凍結版に入る**（旧計画 §1.1 PR-O4 の依存列）。新ラインでは `session.evaluate` が構造的に 1 リクエスト = 1 `execute()` なのでフレームのメタ行は不要（設計 §5.3） |
| PR-L7 `feat(session-log): result / import records; agent provenance from the MCP path` | `extension.ts` `evaluateForAgent` | `session.evaluate` の `source: "agent"` |
| PR-D2 `fix(diagnostics): run the engine parser behind the editor diagnostics` | `extension.ts`（+40） | `packages/session/src/services/diagnostics`（設計 §5.5） |
| PR-D6 `fix(engine): attribute diagnostics to the submission that caused them` | `repl-mode.ts` / `extension.ts` | request id が wire にあるので**構造で解ける**（`session.evaluate` の応答に診断が付く） |
| PR-V5 `fix(mcp): list audio devices through the daemon on the rust path` | `extension.ts` / `mcp-server.ts` / 新 `engine-status-bridge.ts` | `audio.listDevices` の実装（層 2） |
| PR-V6 `feat(orbitstudio): show device, headroom, dropouts and children in the Engine view` | `engine-view.ts` / `extension.ts` | A-panels の Engine パネル（`engine-view.ts` は pure のまま WebView へ） |
| PR-V7 `feat(orbitstudio): list engine settings with their scope` | `engine-settings-table.ts`（新） | 同上（設定表は層 2 が返す・`engine.getState`） |
| PR-V10 `feat(orbitstudio): wire MIDI panic and live device selection` | `extension.ts` / `mcp-server.ts` | `audio.selectDevice` / `engine.panic`（RPC + MCP 両方・D-4） |
| PR-V12 `feat(orbitstudio): rework the Engine view as a WebviewView` | 新 webview | **不要**（アプリは最初から WebView） |
| PR-S-T1 / T2 / T3 / C1 / C2（workspace trust・node pre-check） | `package.json` / `product.overrides.json` / `extension.ts` | **不要**（trust の概念が無い・node は同梱）。#385 は凍結版の話として残る（所属未定・旧計画 §3 ステージ 1） |
| PR-S-R3 / R4 / R5（`make-local-release.sh` / 署名 / CI） | 旧フォーク前提 | **束 R-app に置き換え**（設計 §9・裁定 §12.3「ステージ 8 は再定義」） |
| PR-E12 `fix(extension): one line router for every chunk stream`（#777 backlog） | `daemon-client.ts` / `extension.ts` | `extension.ts` 側は**新ラインでは不要**（WebSocket フレーミング・設計 §5.2）。`daemon-client.ts` 側（#777 の flush）は層 2 の資産なので旧 PR のまま |

### 4.2 順序（engine 線の中）

旧計画 §3 の順序（O-multiout → 3 ログ → 4 render → 5 可視化 → 6 リリースゲート連鎖 → 7 プラグイン境界）を**そのまま**使う。ただし:

- **O-multiout（PR-O5 / O6）が最初**（裁定 §12.3）。PR-O6 の「O4 が実機で確かめられた後」は凍結版の制作利用が満たす
- engine 線の各束は **headless ターゲットで E2E を回せる**（S-mcp の後）。アプリを待たない
- **可視化（PR-V）の表面はアプリ側**（A-panels）に落ちるので、V6 / V7 / V10 は A-panels の後に着手する（§4.1）

---

## 5. 委譲の割り当て

| 工程 | 担当 | 本プランでの具体 |
|---|---|---|
| 設計 | **Fable**（effort: high・本書は xhigh） | 束ごとの設計文書は**本設計で足りる**。足りなくなった束（S-editor の逆方向契約・A-document の byte 往復）だけ追補を Fable に |
| 設計のチェック | **main** | 実行フロー② |
| 実装 | **Codex**（`--model gpt-5.6-sol --effort high`・難所 = S-rpc の並行性・A-skeleton の 4 層またぎ配線は `xhigh`） | TS / Rust / Swift すべて Codex。🔴 **Swift のコンパイルが sandbox で通るかは N0-a で確かめ、通らなければ「Swift の build 確認は main」に固定** |
| 実装のモニタリング | **main** | 差分の中身を見る |
| **検証** | **main**（sandbox 外・実機） | 🔴 **N0 の 3 spike・IME・署名・GUI 起動・gated `native` はすべて main**。Codex の緑は根拠にしない（CLAUDE.md「検証を委譲先に任せない」） |
| レビュー | `/simplify` → `/code:pr-review-team` + **Fable 監査を並行**（束 PR で 1 回） | Fable への 3 問は固定（不在証明 = 設計 §5.3 の列挙表と実装の照合 / 外部 API の意味論 = `WKWebView` `URLSessionWebSocketTask` `NSDocument` の契約を一次ソースで / 横断的関心事 = D-4・D-5 の構造） |

**Codex へのブリーフに毎回入れるもの**（`consult-delegation` skill）: 触ってはいけない対象 = **`packages/vscode-extension/**` と `packages/engine/src/cli/repl-mode.ts`**（凍結）/ `rust/**`（裁定 2.4・engine 線の束は除く）/ 検証コマンド（`npm test` + `swift build` + 束の E2E 名）/ 報告形式（列挙表の `[x]`）。

**運用の知見（VSCodium 版 Phase 2・Serena `orbitstudio_phase2_spike_2026-07-07`）**: 長時間ビルドを subagent に detached で走らせると**完了通知が飛ばない**。`swift build` や `make-bundle.sh` を委譲する時は main が PID を監視する（memory `subagent-completion-notice-is-not-quiescence`）。

---

## 6. 裁定待ちが止める PR（一覧）

| 裁定（設計 §14） | 状態 | 止まる束 |
|---|---|---|
| (1) detach を第 1 リリースに含めるか | 待ち・推奨 A | **なし**（A なら何も足さない。B なら R-app の後に新束） |
| (2) `packages/engine` rename | 待ち・推奨 A | **なし**（A なら何も触らない） |
| (3) Node 同梱（W-22 引き継ぎ） | 待ち・推奨 A | **R-app**（N0-c の spike は同梱前提で進めてよい・結果は裁定の材料） |
| (4) タグ名前空間 / ワークフロー分割 | 待ち・推奨 案どおり | **R-app の N4-b** |
| (5) 自動更新 | 待ち・推奨 A | なし |
| (6) Swift の CI | 待ち・推奨 A | **R-app の N4-b**（tag 時のみ）。手元ゲートは裁定不要 |
| (7) 拡張を薄いクライアントに | 待ち・推奨 A | なし（着手しない） |
| (8) 複数エディタ | 待ち・推奨 A | なし（1 つまでで実装） |
| (9) `protocol/` のライセンス | 待ち | **S-rpc の `protocol/LICENSE`**（無ければルートの LICENSE が適用され、後から変える作業が増えるだけ。止めない） |
| (10) bundle id / 名前 / 配布物名 | 待ち | **R-app の N4-a**（初回署名の前） |
| (11) not-applicable の表面 | 待ち・推奨あり | **A-parity の N3-c2**（それまで台帳は `native-required` として保持） |
| (12) issue 本文の出力先 `847` → `848` | main | なし |
| (13) ラックをリリースゲートに含める再確認 | 待ち・前提「含める」 | 🚪 の判定のみ |
| (14) app の版の正本 | 待ち・推奨 A（`apps/OrbitStudio/VERSION`） | **R-app の N4-a**（preflight）。それまで `0.1.0-dev` 固定で進める |

**今すぐ着手できる**: N0-a / N0-b / N0-c（裁定待ち 0）・S-rpc（(9) は止めない）。

---

## 7. 更新履歴

| 日付 | 内容 |
|---|---|
| 2026-09-11 | 初版（#848・Fable 起案）。段 N0〜N4・束 9 本・一方通行 10 件・engine 線の付け替え表・裁定待ち 13 件 |
