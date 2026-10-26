# 実装プラン（ネイティブ版）— 段・束・受け入れ基準（#848）

**状態**: 計画（実装しない）・初版 2026-09-11（main `229d6387` 起点）・改訂 2026-09-18（`1276ab1f` — 🔴 09-14 の 4.2.0 マージで、09-18 の main ではない・設計 §2）・**改訂 2026-10-23（main `7410dcb0`・拡張 4.4.0。設計 §2c の判定に従って直した行に「改訂（10-23）」と付す。§2.1 に束ごとの実行環境の列を足した）**・**改訂 2026-10-26（owner 裁定 第 2 回。新しい束 S-eval・N0-d（T-1）・暫定物の台帳・同梱の中継。§7 に「クラウドに続けて渡せる順の作業列」を新設）**
**用語**: **OrbitStudio = macOS ネイティブ版アプリ**（owner 2026-09-18）。拡張版は「凍結版」「拡張版」と書く。文書（user / dev サイト）の保持構造は [`848-docs-structure-design.md`](../design/848-docs-structure-design.md)（別冊）
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
| N-1 | セッションプロトコル v1（JSON-RPC 2.0 over WebSocket・`/rpc`・逆方向 `editor.*`・通知）の**形**。改訂（10-23）: 形を設計で確定した — `session.evaluate` は状態を持たない（`documentDirectory` 毎回必須・`null` = 基準なし）/ `evalId` はサーバが振る / `transport.step` に省略可能な `source`（0 始まり・UTF-16）/ `log.line` に `level` / `kind` / `session.attach` の `token` / `docs.*` の `site` / `limit` / `engine.start` の `hostBundleId`。**評価の単位は wire に焼かない**（#987 Q2・設計 §14 (22)）。改訂（10-26）: `session.evaluate` に省略可能な **`target`**（`uri` / `version` / LSP 形の `range`・設計 §5.3.1）。区切り方は #997 で決める | 束 S-rpc | クライアント（WebView・headless・将来の拡張）が増えた後は変えにくい。同梱なので互換期間は不要だが**形**は残る | 設計 §5.2・§5.3（10-23 確定）。S-rpc の締めのレビューは**設計との一致**を確かめる（#987 の `StepEvent` との突き合わせを含む・設計 §13） |
| N-2 | ディレクトリ `packages/session/` `apps/OrbitStudio/` `protocol/` の新設・`packages/engine` は rename しない | 束 S-rpc | パスは後から変えにくい | 設計 §8・§14 (2) 推奨 A |
| N-3 | `orbitscore session --port --mcp --docs-dir` の起動引数と ready 行の形（改訂: `--docs-dir` は**複数指定可・先勝ち**にする — 別冊 §6.5 の上書きディレクトリと dev サイトの追加同梱 (15) に備える。v1 で使うのは 1 つ）。改訂（10-23）: ready 行に **`token`**（秘密・転写しない）、起動引数に `--token-file` / `--workspace-root` / `--parent-pid` / `--web-dir` / `--host-bundle-id` / `--plugin-catalog` / `--plugin-scan-path`、stdin はパイプ（EOF = 親の終了）。改訂（10-26・裁定 4）: ready 行に **`socket`**（UDS のパス）、`port` と `token` は **TCP を開いた時だけ**（それ以外は `null`）。起動引数に **`--runtime-dir`**、**`--mcp` は削る**、`--port` は WebView のためだけ。中継の入口 **`orbitscore relay [--runtime-dir]`** 改訂（10-26・裁定 4）: **`--mcp` は削った**（MCP は中継が話す）。起動引数に `--runtime-dir`、ready 行に `socket` を足し、`--port` と `token` は WebView 用の TCP の `/rpc` のためだけに残す（設計 §4.4） | 束 S-rpc | host（Swift・ハーネス・中継）が依存 | 設計 §4.4・§4.5・§4.7・§6.2 |
| N-4 | ハーネスの env `ORBIT_GATED_TARGET = vscode \| native \| headless`（既定 `vscode`）。改訂（10-23）: アプリへ渡す **`ORBITSCORE_SESSION_TOKEN_FILE`**（ハーネスがトークンを知る経路）。🔴 改訂（10-26）: **`ORBITSCORE_SESSION_TOKEN_FILE` は削り、`ORBITSTUDIO_RUNTIME_DIR` に置き換える**（ハーネスは中継から UDS で入るのでトークンを知る必要が無い。runtime-dir で利用者の動いているアプリから分離する） | 束 S-mcp | CI・手順書・memory が依存 | 設計 §10.2 |
| N-16（10-26） | **中継の登録の形**: スタブの置き場（`~/Library/Application Support/OrbitStudio/bin/orbitstudio-mcp`・提案）・サーバ名 `orbitstudio`・既定のスコープ user・`.mcp.json` に書く形（`${HOME}` で始まる `command`・秘密なし） | 束 S-mcp（登録の PR）/ スタブの解決の手段は N0-c | 利用者の LLM クライアントの設定に書かれる。後から変えると全員に登録し直しを求める | 設計 §6.3 |
| N-5 | パリティ台帳 `tests/e2e/native-parity-ledger.ts` の形（基準タグ時点の `it` 題名を全列挙・分類必須）。改訂（10-23）: **基準タグは定数 `PARITY_BASELINE_TAG` 1 か所**（現在 v4.4.0・56 `it`）。凍結版に例外が入ったらその PR で進める。改訂（10-26・裁定 1）: **分類の規則** — DSL が実行された結果・音・能力を確かめる題名は `native-required`、拡張版の形だけを確かめる題名は理由つきで `not-applicable` | 束 S-mcp | 増やす方向にしか編集できないラチェット | 設計 §1.2 D-1・§5.7 |
| N-14（10-26） | **`protocol/` の定義のライセンス = Apache-2.0**（`protocol/LICENSE`） | 束 S-rpc（N1-a1・スキーマを置く PR と同じ PR） | 定義が公開されて使われ始めた後に変えると、使った人に影響する | ✅ §14 (9)（10-26 第 2 回） |
| N-15（10-26） | **暫定物の台帳の形**（`PROVISIONAL(P-xx)` の印・期限の 4 種・release モード） | 束 S-rpc（N1-a0・最初の足場と同じ PR） | 印の文法はコードの全体に散る。後から変えると全部の印を書き換える | 設計 §1.4.2 |
| N-6 | スキーマの `x-surfaces` と `npm run protocol:check`（生成物をコミット） | 束 S-rpc | 生成物の置き場 | 設計 §5.8 |
| N-7 | Node を `.app` に同梱 | 束 R-app | 署名対象 +1・entitlements | ✅ §14 (3) = **A 同梱**（10-26 第 2 回）。改訂: **W-22 の「引き継ぎ」ではなくアプリ線の独立した判断** — 拡張側は #878（PR #889）で VS Code 同梱の Node（`ELECTRON_RUN_AS_NODE`・`engine-process.ts:407-416`）に乗り、同梱 node を要らなくした。Swift app に Electron は無い。Node は層 2 を動かす入れ物で、層 2 の言語を固定する判断ではない（設計 §4.6） |
| N-13（改訂） | **同梱 docs の形**（`Contents/Resources/docs/` = user サイトの Markdown + ビルド済み HTML + DSL 仕様 + `manifest.json`・別冊 §6.2） | 束 R-app（`make-bundle.sh`）。**可用性表記の文法**（別冊 §5）は docs 側の main 直行 PR で先に | LLM 向けの索引と `docs.get` のパス体系が固定される。文法は全章に書かれると変えにくい | 🔴 §14 (15)(16) |
| N-8 | `.app` の bundle id・アプリ名・配布物名・署名 Team ID | 束 R-app（**初回署名の前**） | macOS 上で別アプリになる（656 §5.2） | ✅ §14 (10) = A `com.signalcompose.orbitstudio`（10-26）。Team ID は署名時 |
| N-9 | タグ名前空間 `app-v*` / `ext-v*`・`release-app.yml` | 束 R-app | リリース手順 | ✅ §14 (4) = 案どおり（10-26） |
| N-10 | 拡張（凍結）を新 RPC の薄いクライアントにするか | 着手しない | 凍結違反 | ✅ §14 (7) = **書き直さない**（10-26 第 2 回）。他のエディタから繋ぐ日は、公開したプロトコルに繋ぐ一般の窓口として作る（設計 §10） |
| N-11 | **app の版の正本**（656 §4.4「拡張の `version`」は失効・設計 §9.0） | 束 R-app（preflight） | 利用者の更新経路と Releases の版履歴に焼き付く | ✅ §14 (14) = A `apps/OrbitStudio/VERSION`（10-26） |
| N-12 | ハーネスの `ORBIT_GATED_APP_PATH`（656 §6.2 の `ORBIT_GATED_EXT_MODE=installed` の後継） | 束 A-skeleton | 手順書が依存 | 設計 §10.2 |

**方針**: 一方通行は **(a) 束の先頭か単独に置き**、**(b) 消費者が 0 のうちに確定し**（N-1〜N-3 は S-rpc の時点で消費者はテストだけ）、**(c) owner 裁定待ちのものはその束だけが止まる**形に分割する（N-7〜N-9 は R-app にしか無い）。

---

## 1. 段（ステージ）と依存グラフ

```
                ┌──── アプリ線（本プランの本体） ─────────────────────────────────────────┐
                │                                                                          │
  N0 spike ──┬─→ N1 層 2 抽出 ──→ N2 walking skeleton ──→ N3 エディタ・パネルのパリティ ──→ N4 配布 ──→ 🚪 第 1 リリース
  (IME/schema │   S-rpc → S-mcp → S-editor    A-skeleton      A-document → A-panels → A-parity   R-app          │
   /sign/     │                    │                                                 ↑                           │
   T-1 = N0-d)│                    └──→ S-eval（段階 2・#997 の評価のかたち）──────────┘（A-parity の前に入れる）       │
              │   #997 の設計（docs）──────↗                                                                       │
              └─→（IME が崩れたら Electron 検討へ戻る・設計 §1.3。層 2 の transport は変わらないので N1 は止めない）
                                                                                                                 │
  ┌──── engine 線（層 1 / 2・旧計画の PR をポインタで・§4）───────────────────────────────────────────────────┤
  │  O-multiout（新ラインの最初の束・裁定 §12.3）→ L（ログ→リプレイ）→ R（render）→ V（可視化・性能）           │
  │  → Q/K（queue・PDC・layer・instrument rack・標準プラグイン = 🚪 ラック）→ P（プラグイン境界）                │
  └──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  🚪 第 1 リリースの条件 = N4 完了 ∧ K（ラック #635 / #636 / #669）完了（裁定 §12.2「ラックはリリースの前提」は新ラインに生きる・設計 §14 (13)）
                         ∧ 改訂（10-26）: 暫定物の台帳の `release-1` の行が全部閉じている（設計 D-11・S-eval を含む）
                         ∧ T-1 の判定が「ゲート」なら PR-Q（#428）も（設計 §4.6）
```

矢印は「左が終わらないと右が**着手できない**」。**同じ行に並ぶものは順序を持たない**。アプリ線と engine 線は**独立**（ブランチも実機も共有しない・#848 本文）。engine 線の PR が拡張側に触る行は §4 で `packages/session` / `apps/OrbitStudio` へ付け替える。

### 何が何を塞ぐか（🔴 foundation 相当）

| 段 | 塞いでいるもの | 理由 |
|---|---|---|
| N0-a（Monaco + IME） | N2 以降の**全部**（崩れたら §1.3 の戻り） | 裁定 §9「最大の未知数」 |
| N1 S-rpc（プロトコル v1） | N1 S-mcp / S-editor・N2・headless | クライアントは全部これに乗る |
| N1 S-mcp（MCP を層 2 へ + headless ターゲット） | パリティ台帳（D-1）・D-3 | 台帳は headless で最初に走る |
| N2 A-skeleton | N3 全部 | skeleton が無いと表面を足せない |
| N4 R-app | 🚪 | 配布の一方通行 3 件（N-7〜N-9）は owner 裁定待ち。改訂（10-26）: 3 件とも裁定済み（(3) A・(10) A・(4) 案どおり） |
| #997 の設計（10-26） | S-eval | 評価のかたちが決まらないと段階 2 に入れない。足場（段階 1）は #997 を待たない |
| S-eval（10-26） | A-parity・🚪 | 段階 2 の後でないと、A-parity が最終形を検算しない。足場が残ると D-11 でリリースが落ちる |
| N0-d（T-1・10-26） | engine 線の PR-Q の位置 | 判定が「ゲート」なら PR-Q を 🚪 の条件に入れる（設計 §4.6）。判定の記録が無いまま A-skeleton を始めると台帳 P-06 が red |

---

## 2. 束の切り方

### 2.1 束の一覧（統合ブランチ・中身・概算・検証）

🔴 統合ブランチ名は **束ごとの issue を地図の節から起票してから**その番号で切る（地図 §0.2・PROJECT_RULES「ISSUE 番号のないブランチ名は禁止」）。起票までは `848-` を仮置きし、起票時に本表を更新する。

| 束 | 統合ブランチ（仮） | 中身（小 PR） | 概算（変更行・**未実測**） | 検証（束 PR で） | 🔴 ここで切る理由 | 実行環境（改訂 10-23・事実） |
|---|---|---|---|---|---|---|
| **N-spike** | `848-native-spike` | **N0-a** Swift + WKWebView + Monaco（`.orbs` ハイライト・⌘Enter・**IME**）。改訂（10-23）: **IME は設計 D-6 の再現手順 ①〜⑤**（monaco-editor #4796 / #5390 / #3549・変換中の ⌘Enter・blur 中の `compositionend`）で判定し、**Monaco の版の固定とパッチの当て方**を決める。**WebView の配信元 3 つ（`http://127.0.0.1:<port>/app/` / `file://` / 独自スキーム）それぞれで WebSocket のハンドシェイクが送る Origin の実際の値**と、**ATS `NSAllowsLocalNetworking` が要るか**を測る（設計 §7.3）/ **N0-b** `protocol/` の生成ツール選定（3 メッセージ往復）/ **N0-c** SwiftPM → `.app` 組み立て → 同梱 node 起動 → 署名（hardened runtime）で `spctl` 通過。改訂（10-26）: **中継のスタブ**（`~/Library/Application Support/OrbitStudio/bin/orbitstudio-mcp`）がアプリをどう解決するか・シェルか小さな実行ファイルか・**App Translocation** の下で登録が生きるか・中継の起動から `initialize` の応答までの時間（設計 §6.3・§13）/ 改訂（10-26）: **N0-d T-1 タイミングの基準測定**（設計 §4.6）— 今のハーネスの `vscode` ターゲットのまま、`audio()` と `instrument()`（`CLAPTestSynth`）を同じ grid で鳴らし、サンプル単位のオンセットで隣接間隔のばらつきを m0 / m1 / m2（負荷の下）で測る。サンプル単位のオンセットの helper（`readChannelSamples` / `findEnvelopeCrossing` を `tests/e2e/helpers/` へ）と記録用の gated 1 本を足し、`docs/research/848-timing-baseline.md` に数値と**判定の行**を書く | 約 900（+ N0-d 約 200・未実測） | N0-a: **owner 実機確認**（IME・D-6 の ①〜⑤・Monaco の版を `WORK_LOG` に）+ Origin の実測表（3 配信元）+ ATS の要否を `docs/research/` に記録 / N0-b: 生成物の往復テスト / N0-c: 署名済み skeleton が起動し node が走る（entitlements の実測表を `docs/research/` へ）/ N0-d: 前提チェック（`CLAPTestSynth` のオンセットがブロック長より細かい位置に出る）が緑・判定の行が記録されている（台帳 P-06） | 結果が**設計の前提**（§1.3・§7.3・§9.2・§4.6）を左右する。実装より先に、実装と混ぜずに | **macOS 実機が要る**（WKWebView・IME・署名・Swift・N0-d は capture と音声デバイス）。N0-b の TS 側の生成だけは Linux でもできるが、往復の検査は Swift 側が要る |
| **S-rpc** 🔴 | `1001-session-rpc`（#1001・2026-10-26 起票） | 改訂（10-26）: **N1-a0** 評価の受付口の**足場**（段階 1・凍結版の区切り方の写し・`packages/session/src/eval/`・`PROVISIONAL(P-01)`）+ 凍結版 `createReplSession` との**差分テスト = 一致**（台帳 P-02）+ **暫定物の台帳の仕組み**（`tests/repo/native-provisional-ledger.ts` / `.spec.ts`・設計 §1.4.2）+ **D-8 の follow-up**（`planning-issue-state.spec.ts` の `DOCUMENTS` に新地図と新計画・台帳 P-10）/ **N1-a1** `protocol/session/v1` スキーマ + 生成 + `protocol:check` + **`protocol/LICENSE`（Apache-2.0・N-14）**（`session.evaluate` は状態を持たない形・**`target`**・`evalId`・`transport.step` の `source`・`log.line` の `level` / `kind`・`session.attach` の `token`〔TCP だけ必須〕・設計 §5.2 / §5.3）/ **N1-a2** `packages/session` の WebSocket サーバ（**UDS と TCP の 2 リスナー・同じハンドラ**・handshake・attach・TCP の **Host + Origin〔欠落も拒否〕+ トークン**・runtime-dir の 0700 の検査・取り残しのソケット・`session.evaluate`・`transport.step`・`log.line`・`session.getLog`）+ engine の console 出力の受け取り（暫定・`PROVISIONAL(P-07)`）+ `engine.stop` が daemon の消滅まで待つことの確認（設計 §5.3.2 の未確認・待たなければ層 2 で待つ）/ **N1-a3** `orbitscore session` CLI（ready 行に `socket` / `port` / `token`・`--runtime-dir`・`--port`・`--token-file`・`--workspace-root`・`--parent-pid`・**stdin の EOF と親 PID で終了する機構**（F-1）・shutdown・daemon の畳み方。`--mcp` は無い） | 約 1,300（10-23 の約 1,100 + UDS・台帳の仕組み・未実測） | unit（2 クライアント同時 attach・FIFO の順序・不一致 version の拒否・**D-10 の (1) 7 ケース・(2) `POST /mcp` → 404・(3) 権限・(4) UDS はトークンなし**・stdin のパイプを閉じると終了・`log.line` の分類が凍結版の `shouldFilterLine` / `isDaemonNonErrorTracingLine` の事例と一致・**差分テストが一致**・**台帳の spec が緑**）+ **実機**: headless で `session.evaluate` → capture RMS > 0 | 一方通行 N-1〜N-3・N-6・N-14・N-15 を**この束だけ**に閉じる | 実装と unit は **Linux（クラウド）で完結**（engine はモックで駆動できる・`tests/cli/repl-*.spec.ts` と同じ形。`npm test` は既に ubuntu で回っている・`.github/workflows/code-review.yml:9,26`。UDS も Linux で同じ API）。受け入れの実機（capture RMS > 0）は **macOS 実機** |
| **S-mcp** 🔴 | `848-session-mcp` | **N1-b1**（改訂）**MCP 層 8 ファイル 1,885 行**（10-23 実測・`mcp-server` / `mcp-tools-{editor,engine,plugins}` / `mcp-types` / `mcp-docs` / `mcp-sdk` / `mcp-registration`・全部 pure・設計 §3.1）を `packages/session/src/mcp/` へ移動し、**`OrbitScoreToolHandlers`（`mcp-types.ts:184-235`）を RPC クライアントで実装**する（`agent-handlers.ts` は書き換えず、同じ型を別実装で満たす）。改訂（10-23）: **28 本を全ターゲットで凍結版と同じ順序に登録**（設計 §6）・`evaluate_orbitscore` の IM.6 の解決とエラー文言（設計 §5.3.1。改訂 10-26: **改行禁止は写さない**・`target.uri` へ写す）・`docs.*` の `site` / `limit` / dev が無い時の契約・`evaluate-document-directory.ts`（95 行）を移す / 改訂（10-26）**N1-b2 中継** `orbitscore relay`（stdio の MCP サーバ・`packages/session/src/relay/`・UDS の RPC クライアント・`tools/list` をビルドに埋める・**RL-1〜RL-8**・設計 §6.2）+ `session.registerMcp` が**スタブの stdio 登録**を書く（秘密もポートも無し・`register_mcp_server` の `port` は受け取って使わない・設計 §6.3）/ **N1-b3** ハーネスに `ORBIT_GATED_TARGET=headless` + **中継を stdio で起動する MCP クライアント**（`helpers/mcp-client.ts` に stdio の transport）+ **`ORBITSTUDIO_RUNTIME_DIR`** での分離 + `openWorkspace` → `--workspace-root` / **N1-b4** `native-parity-ledger.ts`（**`PARITY_BASELINE_TAG` = v4.4.0 の 56 `it` 題名**を全列挙・`needs-editor` 分類・未分類 red。改訂 10-26: 分類の規則 = DSL の実行結果・音・能力は `native-required` / 拡張版の形だけは理由つきで `not-applicable`）+ **`tests/protocol/mcp-tools-v1.spec.ts`**（v1 関門・例外の表・`MCP_V1_GATE_UNTIL` で自動で外れる・設計 §6.1） | 約 1,300（10-23 の約 900 + 中継と v1 の spec・未実測）。🔴 1,500 を超える見込みなら N1-b2（中継）を独立の束 **S-relay** に切る（検算は同じ「goldens が動かない」なので、切っても検算の機会は失われない） | 🔴 **goldens が 1 つも動かないこと**（`OUTPUT_LINE_GOLDENS` / rack 期待値）を headless で**中継を通して** + editor 非依存の題名が全件緑（D-3）+ 中継の `tools/list` が設計 §6 の 28 名を同じ順序で返す（`mcp-tools-v1.spec.ts`）+ **D-10 の (6) と D-12 の unit**（RL-1〜RL-7）| **振る舞いを変えない host の入れ替え**なので、検算は「goldens が動かないこと」。S-editor（振る舞いを足す）と同じ束に入れるとこの検算は失われる | 移動・実装・中継・unit は **Linux で完結**。gated headless（daemon・実音・capture）は **macOS 実機** |
| **S-editor** | `848-session-editor` | **N1-c1** document 同期（`editor.didOpen/didChange/didClose/didChangeSelection` + 改訂 10-23 `didChangeActive`）と写し / **N1-c2** 診断・補完・subject-block を層 2 のサービスへ（`diagnostics-analysis.ts` / `plugin-name-diagnostics.ts` / `completion-context.ts` の vscode 依存除去 / `getLineSubject` の移動〔`run-selection.ts:27`〕/ **`plugin-ui-at-cursor.ts` の「カーソル下のプラグイン名 → `(receiver,index)`」解決**を `plugin.openUiAtCursor` として層 2 へ・#939 / #940 の規則込み）/ **N1-c3** 逆方向 `editor.*` リクエストと `NO_EDITOR_ATTACHED` | 約 1,200 | unit（`editor.diagnostics` 通知と `get_diagnostics` の一致・subject-block の既存 unit を層 2 で再実行・IM.6 の第 2 候補が `didChangeActive` に従う）+ 実機: headless で `open_file` が `NO_EDITOR_ATTACHED` を返す | 逆方向の契約（設計 §5.4）を単独で確かめる | 実装と unit は **Linux で完結**。実機の headless は **macOS 実機** |
| **S-eval** 🔴（10-26 新設・段階 2） | `848-session-eval`（#997 から起票し直す） | **N1-d1** #997 の評価のかたちで受付口を置き換える（区切りの単位・途中のエラー・`@import` をまたぐ評価・`target` から区切りを決める）。足場（台帳 P-01）の印とモジュールを消す / **N1-d2** 差分テストを「**違いの記録**」に書き換える（期待値 = 凍結版との差の一覧・各件に #997 のどの決定による差か。一覧に無い差は red・台帳 P-02）/ **N1-d3** engine に型付きの出力の口（step / log / diagnostic）を足し、session の console の横取りを消す（台帳 P-07。既定の出力先は console のまま）/ **N1-d4** `transport.step` の `source` を埋める（#987 の位置情報・台帳 P-04 の層 2 の側） | 未実測（#997 の設計で決まる） | 🔴 **golden が 1 つも動かない**（D-2。正しい DSL の音は変えない — 動いたら owner に確かめる）+ #997 の検証ケース（#965 / #620 / #695 / #987 / #630 と owner の例）が期待どおり + 差分テストの「違いの記録」に無い差が 0 + 台帳 P-01 / P-02 / P-07 が `closed` | 段階 1（S-rpc / S-mcp・振る舞いを変えない移し替え）と混ぜない（設計 §4.5.1・§2.2 の 4） | 評価の実装と unit・差分テストは **Linux で完結**。golden（headless の capture）は **macOS 実機** |
| **A-skeleton** 🔴 | `848-app-skeleton` | **N2-a** Swift シェル（1 ウィンドウ・WKWebView・session の spawn（stdin をパイプで渡す・`--parent-pid`・改訂 10-26: `--runtime-dir`・`--port 0`・`--token-file`）/ ready 行の消費（転写しない）/ 監視 / shutdown・⌘Enter）+ 改訂（10-23）: **トークンを `WKUserScript`（main frame のみ）で注入・`/app/` の外へ遷移させない**・**F-12 のアプリ側**（改訂 10-26: 層 2 の終了を検知 → **自動で起動し直す**〔連続して落ちる時だけボタン〕→ 再 attach → 全 document の `didOpen` 再送 → モーダルでない通知 + 失われたプラグインの状態 + 再評価ボタン。残った daemon の掃除は `PROVISIONAL(P-05)`）+ 改訂（10-26）: 起動のたびに**中継のスタブ**を書く（設計 §6.3）/ **N2-b** Web クライアント（Monaco + RPC クライアント + playhead。`transport.step` の `source` を正本に、`null` の間は `playhead.ts` を暫定の消費者に・`PROVISIONAL(P-04)`・設計 §1.3）/ **N2-c** ハーネスに `ORBIT_GATED_TARGET=native`（起動・改訂 10-26: `ORBITSTUDIO_RUNTIME_DIR` と中継・PID オラクルの teardown） | 約 1,500（Swift 700 / TS 800・**上限に近い**。N0-a の Monaco 設定を持ち越して減らす） | 設計 §1.3 の 1〜5 + 🔴 **goldens が動かないこと**（native）+ IME（owner・D-6 の ①〜⑤）+ D-10 の native 版（TCP の `/rpc` にトークンなし → 拒否）+ 改訂（10-26）: **D-12 の gated 2 本**（アプリの立ち上げ直し・F-12 の後に同じ中継で次の呼び出しが通る）| walking skeleton を**表面を足す前に**閉じる。裁定 §5 Phase 2「数週間で結論が出る想定」の単位 | **macOS 実機が要る**（Swift・WKWebView・IME・実音） |
| **A-document** | `848-app-document` | **N3-a1** `NSDocument`（open / save / autosave / 未保存確認・バイト同一の往復）/ **N3-a2** タブ・メニュー・最近使った書類（改訂 10-23: 起動時に渡されたフォルダを `--workspace-root` に・設計 §4.5.2。「フォルダを開く」メニューを置くかはここで決める）/ **N3-a3** 環境設定（改訂 10-23: **設定 8 項目**の写像・設計 §7.4） | 約 900 | 実機: `open_file` → `edit_replace` → `save_file` → ファイルが byte 一致（E2E）+ 自動保存の実機確認 | AppKit 標準機能の受け入れ。ライブ経路とは独立 | **macOS 実機が要る**（AppKit） |
| **A-panels** | `848-app-panels` | **N3-b1** Engine パネル（`engine-view.ts` の写像・デバイス選択・起動停止・`restartEngine` = `engine.stop` + `engine.start`）/ **N3-b2** Log パネル + ステータス（`transport.state`・`log.line` の `level` で色分け）/ **N3-b3** Catalog パネル（rescan / browse = `plugin.list` + Monaco への挿入 / 右クリック → `plugin.openUiAtCursor`）/ **N3-b4** Docs パネル（改訂 10-23: **`/app/` とは別の WKWebView**・同梱の user サイトをネットワーク無しで表示 = 凍結版 4.2.1 の同梱を引き継ぐ・dev は「モノレポでだけ読める」案内）/ **N3-b5** flash と playhead palette | 約 1,000 | 実機: `select_audio_device` 後に capture RMS > 0（E-2 相当）/ `get_log` と Log パネルの行数一致 / `rescan_plugins` 後に Catalog に fixture が出る / 改訂 10-23: `get_user_doc` が同梱 docs の 1 章を返す・`get_dev_doc` が unavailable の案内を返す（凍結版の cold-install の `assertDocsBundled` と同じ検査） | 表面ごとに E2E が付く。D-4 の検査をここで初めて全面適用 | **macOS 実機が要る** |
| **A-parity** | `848-app-parity` | 改訂（10-26）: **N3-c0** WebView から `playhead.ts` を外し `transport.step` の `source` を正本にする + gated `native` の 1 本「文書の評価の `transport.step` が `source` を持つ」（台帳 P-04・S-eval の後）/ **N3-c1** 台帳の残り（`native-required` の全件緑）/ **N3-c2** `not-applicable` の owner 裁定を台帳へ（§14 (11)・改訂 10-23: `showCommands` を含む）/ **N3-c3** D-5（モーダル無し・50 回連続評価の分散）/ 改訂（10-26）: **N3-c4** T-1 を `native` ターゲットでやり直す（判定が「ゲートにしない」だった場合・設計 §4.6）/ 地図 §3.4 の `must-fix` の行（「A-parity までは付けない」）を外す | 約 600 | **D-1 全件緑 + D-2 + D-3 + D-4 + D-5 + D-10 + D-12**。改訂（10-26）: 台帳の spec を release モードで回して、`release-1` の行のうち R-app の前に閉じるべきもの（P-01・P-02・P-04・P-05・P-07・P-08）が閉じている | 完了条件の締め。ここを過ぎたら**拡張版に無い機能**を足してよい | **macOS 実機が要る** |
| **R-app** 🔴 | `848-release-app` | **N4-a** `make-local-release.sh`（app 版・656 §4.2 の 12 段を設計 §9.2 の対応表で差し替え・`verify-app.sh`・内側から署名 → dmg → notarize → staple）+ entitlements と `Info.plist`（N0-c の実測表・N0-a の ATS の結論から）/ **N4-b** `release-app.yml`（`app-v*` tag・macos-14・同じ 1 本を呼ぶ）/ **N4-c** cold-install E2E（`ORBIT_GATED_APP_PATH=<成果物>` で gated `native`・PATH を絞る・quarantine を明示的に付ける = 656 E2E-D3 の後継）/ **N4-d** docs（`CODESIGN_PIPELINE.md` 全面改訂・`installation.md`・656 §13 の引き継ぎ）/ **N4-e** **docs 同梱**（改訂 10-23: 凍結版 4.2.1 の user サイトの同梱を引き継ぐ。`make-bundle.sh` 段 2 で `docs:build:user` + `build-docs-bundle.mjs` → `Contents/Resources/docs/`・`verify-app.sh` に manifest / index.html / **`未リリース` 0 件**の検査 = D-9・別冊 §6）/ 改訂（10-26）: **N4-f** `verify-app.sh` が台帳の spec を **release モード**（`ORBIT_RELEASE_PREFLIGHT=1`）で呼ぶ（D-11）+ 自動更新（§14 (5) B・設計 §9.3）+ `VERSION` を決める PR で `MCP_V1_GATE_UNTIL` を入れる（設計 §6.1） | 約 900（+ N4-e 約 200・未実測） | 別アカウントで `.dmg` → 音（D-7）+ `spctl --assess` + 署名済み `.app` で 3rd-party が鳴る（656 E2E-D4）+ `verify-app.sh` exit 0（656 E2E-D5 の後継）+ cold-install で `get_user_doc` が同梱 docs を返し `get_dev_doc` が unavailable を返す（D-9）+ 改訂（10-26）: **台帳の spec が release モードで緑**（D-11・足場が残っていたら落ちる） | 一方通行 N-7〜N-9・N-11・N-13 を**この束だけ**に閉じる。**owner 裁定が来るまで他の束は止まらない**。🔴 **656 を再設計しない** — 差分は設計 §9.0 の表 | **macOS 実機が要る**（署名・公証・別アカウント）。`release-app.yml` は GitHub の macos-14 |

**docs の連続 PR（main 直行・束を通さない・改訂）**: 別冊の順序 — ① 可用性表記の文法と frontmatter `host:` を `sites/user/STYLE_GUIDE.md` に足し、lint（`sites/user/scripts/check-availability.mjs`）を置く ② 現在の章に frontmatter と host 依存段落の併記を入れる（別冊 §3 の表どおり）③ docs 追従ルーチンの手順を (18) の裁定に合わせて更新。①〜③ はコードを触らない docs PR なので R-app を待たず、**S-mcp の前に済ませてよい**（`mcp-docs.ts` が manifest を読む形にするのは S-mcp の中）。

**main 直行**（束を通さない）: 本設計 3 本（docs）/ `CLAUDE.md` のマージ前ゲートに `swift build` を足す行（docs）/ N0 の spike レポート（`docs/research/`・docs）/ 凍結版への bug fix（従来どおり単独フルレビュー）。

### 2.2 「検算の機会」で切った箇所（`BUNDLE_BRANCH_WORKFLOW.md` §5.1）

1. **S-mcp を S-editor と分けた** — S-mcp は「拡張の MCP を層 2 に**移す**」だけで振る舞いを変えない。検算は「goldens が動かないこと」。S-editor は逆方向リクエストと診断サービスを**足す**ので goldens は正当に変わりうる（診断の件数）。同じ束にすると「移動で音が変わったか」を二度と問えない
2. **A-skeleton を A-document / A-panels と分けた** — skeleton は「アプリからも同じ音が出る」を goldens で確かめる最初で最後の機会。表面を足した後では、赤の帰属が「アプリの表面が誤り」と「配線が誤り」に割れる
3. **R-app を単独にした** — 配布の一方通行（bundle id・tag・node 同梱）は owner 裁定を待つ。他の束が裁定待ちで止まらないようにする
4. 改訂（10-26）: **S-eval を S-rpc / S-mcp と分けた**（owner 裁定 2 = A 段階を分ける）— S-rpc / S-mcp は凍結版と同じ区切り方で移すだけなので、検算は「差分テストが一致・golden が動かない」。S-eval は評価のかたちを変えるので、検算は「違いの記録に無い差が 0・golden が動かない」。同じ束にすると、音が変わった時に移行のバグか意図した変化か区別できない。🔴 **分けた分、段階 2 を忘れる危険が生まれる**ので、足場に台帳の印を付け、リリースの preflight が落とす（設計 §1.4・D-11）

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
  - N0-a: WKWebView 上の Monaco で `.orbs` がハイライトされ、⌘Enter が JS 側に届き、改訂（10-23）: **日本語 IME が設計 D-6 の再現手順 ①〜⑤ を 1 つも再現しない**（owner 確認・①〜⑤ の結果・日付・hash・**Monaco の版**を `WORK_LOG`）。**Monaco の版の固定とパッチの当て方**を決めて計画に戻す。**WebView の配信元 3 つ（`http://127.0.0.1:<port>/app/` / `file://` / 独自スキーム）で WebSocket のハンドシェイクが送る Origin の実際の値**を node の `ws` サーバに記録させて表にし、**ATS `NSAllowsLocalNetworking` が要るか**を決める（旧版の「`file://` から繋がるか・可否どちらでも設計は変わらない」は撤回 — 設計 §7.3）。TextMate 流用か Monarch かを 20 譜面のトークン列比較で決める
  - N0-b: `protocol/session/v1/` の 3 メッセージが TS ↔ Swift で往復して等しい。生成ツールを固定
  - N0-c: `Package.swift` → `make-bundle.sh` → `.app` に node を同梱 → hardened runtime で署名 → `spctl --assess` 通過 → node が `--version` を返す。**entitlements の実測表**（656 §5.3 の手順）を `docs/research/848-native-spike-report.md` に残す。改訂（10-26）: `.app` を移した後とダウンロード直後（Translocation）に、登録したスタブから中継が起動して `tools/list` が返る。スタブの形を決めて設計 §6.3 に戻す
  - 改訂（10-26）N0-d（T-1）: `docs/research/848-timing-baseline.md` に m0 / m1 / m2 の中央値・p99・最大、日付・commit・デバイス・バッファ長、**判定の行**（`判定: ゲート` / `判定: ゲートにしない`）がある。判定の規則は設計 §4.6（m1 の p99 > m0 の p99 + 64 フレームならゲート・提案値で main が確かめる）。判定が「ゲート」なら main が #428 に `release-gate` を付け、地図 §3.4 を直す
- **🔴 実機**: 上の 3 つはすべて実機でしか答えが出ない。**Codex の sandbox では 1 つも走らない**（GUI・署名・キーチェーン）。main が回す。
- **閉じる**: 設計 §13 の該当行を更新。崩れた項目があれば**実装に進まず報告**（CLAUDE.md「Phase 0 の停止条件」と同じ扱い）。

### N1 — 層 2 の抽出（束 S-rpc → S-mcp → S-editor）

- **結果**: `orbitscore session`（改訂 10-26: TCP を開かない既定）と、同梱の**中継**を 1 回だけ登録した LLM クライアントだけで、エディタ無しに LLM が今日と同じ MCP ツールでセッションを操作できる。拡張は**触っていない**。
- **受け入れ**:
  - S-rpc（改訂 10-23）: unit — attach 2 件・FIFO・version 不一致の拒否 / **評価の単位の写しと凍結版 `createReplSession` の差分テストが一致**（設計 §4.5.1。旧版の「1 リクエスト = 1 `execute()`」は撤回 — 実装の既定は凍結版と同じ行ごとの評価・設計 §5.3.1）/ **`session.evaluate` は `documentDirectory` を毎回必須で受け**、`null` が基準のクリアになり、応答に `evalId` と使った `documentDirectory` が載る / `transport.step` に `source`（v1 の実装では `null`）/ `log.line` の `level` / `kind` が凍結版の `shouldFilterLine`・`isDaemonNonErrorTracingLine` の事例と一致 / 改訂（10-26）: **D-10 の (1)〜(4)**（TCP の `/rpc` の拒否 6 通り + 通る 1 通り・`POST /mcp` → 404・runtime-dir の権限・UDS はトークンなしで attach）/ `session.evaluate` の `target` を受け取って `.orbslog` の `sourceFile` に写す / 台帳の spec が緑（印 `PROVISIONAL(P-01)` と `(P-07)` が台帳に在る）/ **F-1 の機構**: stdin のパイプを閉じると session が畳む経路を通って終了し、`--parent-pid` の PID が消えても終了する / **F-12 の層 2 側**: session を落として同じ引数（同じ runtime-dir）で起動し直し、再 attach + `didOpen` 再送で `session.getState` が元の document 一覧を返す。+ 実機 headless で `session.evaluate` → capture RMS > 0
  - S-mcp: 🔴 **goldens が 1 つも動かない**（headless）+ 台帳（`PARITY_BASELINE_TAG` = v4.4.0 の 56 `it`）の `needs-editor` 以外が全件緑（D-3）+ `get_log` の ERROR が `<=` + 改訂（10-23）: headless の `tools/list` が設計 §6 の **28 名を同じ順序**で返す / `evaluate_orbitscore` の IM.6 のエラー文言（`evaluate-document-directory.spec.ts` を層 2 で再実行）と応答の末尾 `(documentDirectory: …)` が凍結版と同じ（gated `#966` の 2 題名）/ `docs.*` の `site:"dev"` が unavailable の契約を返す / 改訂（10-26）: すべて**中継を通して**（ハーネスは stdio で中継を起動する）/ `mcp-tools-v1.spec.ts` が緑（例外の表の 2 件だけが差）/ **D-10 の (6) と D-12 の unit**（RL-1〜RL-7: 層 2 を `kill -9` して中継の PID が同じ・層 2 なしで `tools/list` と `isError`・再送しない・MAJOR 違いで `isError`・`server/discover` に即答・SIGINT で 100 ms 以内に終了）
  - S-editor: `open_file` が headless で `NO_EDITOR_ATTACHED`（構造化エラー・黙らない）+ 診断の一致 unit
  - 改訂（10-26）S-eval: §2.1 の S-eval の行の「検証」。🔴 **golden が 1 つも動かない** + 差分テストの「違いの記録」に無い差が 0 + 台帳 P-01 / P-02 / P-07 が `closed`（`PROVISIONAL(P-01)` / `(P-07)` の印が 0 件）
- **🔴 実機**: `npm run test:e2e:gated` を `ORBIT_GATED_TARGET=headless` で。daemon の台数（PID オラクル）が各 phase 境界で高々 1。`.orbslog` に `evalSource` / `clientId` が写る（人間 + LLM の交互評価を 1 本のログで）。改訂（10-26）: headless は TCP を開かないのでトークンが無い（D-10 の grep は `native` で行う）。
- **閉じる**: 設計 §5.3 の表の各行が実装済み（列挙表を PR 本文で `[x]` 化・PROJECT_RULES §1d）。改訂（10-23）: #757 は凍結版で共通骨格に畳んで CLOSED（PR #985・2026-10-23）。新ラインでは骨格ごと不要なので台帳に書くことは無い。

### N2 — walking skeleton（束 A-skeleton）

- **結果**: `OrbitStudio.app` を開き、`.orbs` を書いて ⌘Enter で音が出て playhead が動く。タブ・保存・設定は無い。
- **受け入れ**: 設計 §1.3 の 1〜5 + 🔴 **goldens が動かない**（native）+ **IME**（owner・D-6 の ①〜⑤）+ ハーネス teardown で session / daemon が残らない（PID オラクル）+ 改訂（10-23・10-26）: D-10 の native 版（TCP の `/rpc` にトークンなし → 拒否。WebView は Swift が注入したトークンで通る）+ **F-12**（session を `kill` → **自動で起動し直す** → 再 attach → document が戻る → モーダルでない通知と再評価ボタン → 再評価で音が戻る）+ **D-12 の gated 2 本**（アプリの立ち上げ直し・F-12 の後に、同じ中継のプロセスで次の呼び出しが通る）+ 各実行の終わりに TCP のトークン文字列が `get_log` と session の stderr に 0 件。
- **🔴 実機**: `ORBIT_GATED_TARGET=native` で `open_file` → `run_selection` → capture RMS > 0 の 1 本 + goldens。WebView を強制リロードしても音が続く（層 2 が生き残る）。Swift 本体を SIGKILL して **session が消える**（F-1 の機構・stdin の EOF）。daemon が消えるかは engine 線の申し送り（設計 §4.4・#996）が入るまで PID オラクルで観測し、残った分は teardown が止める（台帳 P-05）。改訂（10-26）: **スリープからの復帰**（D-12 の E4）と**別のユーザーからの `connect` が拒否されること**（D-10 の T-2）を 1 回ずつ手で確かめ、`WORK_LOG` に残す。
- **閉じる**: 裁定 §5 Phase 2。**崩れたら Electron 検討へ戻る**（§1.3）— その判断は owner。

### N3 — パリティ（束 A-document → A-panels → A-parity）

- **結果**: 凍結版の拡張でできたことが、アプリで**同じ MCP ツール名**で全部できる。
- **受け入れ**: A-document: 保存の byte 一致 E2E / A-panels: 各パネルに 1 本以上の E2E（設計 §7.4 の行ごと・Docs パネルは**同梱 docs をオフラインで**。改訂 10-23: docs の検査は凍結版の cold-install の `assertDocsBundled` を写す — `get_user_doc` 成功・`get_dev_doc` は unavailable）/ A-parity: **D-1〜D-5・D-10・D-12 の全部**。改訂（10-26）: パネルの置き方・コマンドの構成は参照（裁定 1）なので、凍結版と同じ形にすることは受け入れに入れない。入れるのは**能力**（設計 §7.4）。
- **🔴 実機**: `ORBIT_GATED_TARGET=native` 全件 + `get_log` ERROR `<=` + D-5 の 50 回連続評価 + プラグイン UI の開閉（child の `NSWindow`）が `open_plugin_ui` / `close_plugin_ui` で人手なしに動く。
- **閉じる**: 台帳の未分類 0・`native-required` 全緑。§14 (11) の裁定を台帳へ転記。

### N4 — 配布（束 R-app）

- **結果**: 署名・公証済み `OrbitStudio-<version>-darwin-arm64.dmg` が GitHub Releases に置かれ、新規環境で起動して音が出る。
- 改訂（10-26・§14 (5) = B）: **自動更新を含める**（既定で有効・環境設定で opt-out。appcast・更新の署名鍵・`release-app.yml` の appcast 更新の段。署名・公証の後に載せる）。
- **受け入れ**: D-7 + **D-9**（同梱 docs がオフラインで読め、`未リリース` マーカー 0 件。改訂 10-23: 凍結版 4.2.1 の同梱を引き継ぐ形）+ `spctl --assess` + 656 E2E-D4（署名済み `.app` で 3rd-party が鳴る）+ tag で `release-app.yml` が 1 回通る。
- **🔴 実機**: 別の macOS アカウント（または別機）で `.dmg` から。**PATH に node が無い**状態で。quarantine を `xattr -w` で明示的に付けてから開く。
- **閉じる**: #656 / #659 / #138 を**ネイティブ app の配布として書き直した issue**（起票待ち・地図 §4.D）。

### 🚪 第 1 リリース

N4 完了 ∧ engine 線 K（ラック #635 / #636 / #669）完了 ∧ 改訂（10-26）: 台帳の `release-1` の行が全部閉じている（設計 D-11）∧ T-1 の判定が「ゲート」なら PR-Q（#428）完了。**凍結版 ≠ リリース**（裁定 §12.2）。リリースゲートの残り（`release-gate` ラベル）は旧地図 §3 の連鎖を新地図 §3 で引き継ぐ。

---

## 4. engine 線 — 旧計画の PR をどう扱うか（引き継がないが、ポインタは持つ）

裁定 §12.3「ステージ 3〜7 は層 1 / 2 の作業なのでそのまま生きる」。**PR の中身は旧計画（`IMPLEMENTATION_PLAN_2026-09.md` §1）が正本のまま**。本プランは次の 2 点だけを足す。

### 4.1 拡張側に触る行の付け替え（🔴 新ラインでは `extension.ts` / `repl-mode.ts` を触らない）

| 旧 PR | 旧計画で触る拡張側のファイル | 新ラインでの置き場 |
|---|---|---|
| PR-L1b `feat(extension): enable the session log from OrbitStudio` | `package.json` / `extension.ts`（env・`writeCodeToEngine` 3 引数） | `packages/session`（`session.evaluate` の `frame` と `.orbslog` writer の起動引数）+ アプリ環境設定。**`//#sourceFile` は wire 上に出ない**（`editor.didOpen` の `uri` が持つ）。改訂（10-26）: 評価ごとの `sourceFile` は `session.evaluate` の **`target.uri`**（設計 §5.3.1）から写す |
| PR-L2 `feat(repl): //#evalBegin / //#evalEnd frame` | `repl-mode.ts` / `extension.ts` | ✅ **凍結版に入った**（`repl-mode.ts:108-115` に実在・4.2.0）。新ラインでは `session.evaluate` の 1 要求が 1 バッチなのでフレームのメタ行は不要（設計 §5.3.1）。改訂（10-23）: 🔴 旧版の「構造的に 1 リクエスト = 1 `execute()`」は誤り — 凍結版のフレームの中も**行ごと**にパース・実行しており（`repl-mode.ts:390-556`）、「1 要求 = 1 パース」に変えるかは #987 Q2（設計 §14 (22)）。実装の既定は凍結版と同じ。改訂（10-26）: (22) は閉じ、区切り方は **#997** の評価のかたちで決めて **S-eval** で入れる |
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
| PR-E12 `fix(extension): one line router for every chunk stream`（#777 backlog） | `daemon-client.ts` / `extension.ts` | `extension.ts` 側は**新ラインでは不要**（WebSocket フレーミング・設計 §5.2）。改訂（10-23）: `daemon-client.ts` 側（#777 の flush）は ✅ **凍結版 4.4.0 で入った**（`daemon-stderr-lines.ts`・PR #985・#777 CLOSED 2026-10-23）。層 2 はそれをそのまま使う |

### 4.2 順序（engine 線の中）

旧計画 §3 の順序（O-multiout → 3 ログ → 4 render → 5 可視化 → 6 リリースゲート連鎖 → 7 プラグイン境界）を**そのまま**使う。ただし:

- **O-multiout（PR-O5 / O6）が最初**（裁定 §12.3）。PR-O6 の「O4 が実機で確かめられた後」は凍結版の制作利用が満たす
- engine 線の各束は **headless ターゲットで E2E を回せる**（S-mcp の後）。アプリを待たない
- **可視化（PR-V）の表面はアプリ側**（A-panels）に落ちるので、V6 / V7 / V10 は A-panels の後に着手する（§4.1）
- 改訂（10-26）: **PR-Q（#428・時刻付きイベント queue）の位置は T-1（N0-d）の判定で決まる**（設計 §4.6）。判定が「ゲート」なら PR-Q-A〜F を 🚪 の条件に入れ、K より前に置く（旧計画のステージ 6 の順序 PR-Q → PR-K と同じ向き）。「ゲートにしない」なら旧計画の順序のまま
- 改訂（10-26）: **#996**（daemon の Origin と親の死を知る機構）は engine 線の小さな束。アプリの F-12 の後始末（台帳 P-05）を消す前提なので、A-parity より前に入れる。`release-gate` を付けるかは main（設計 §14.0 Q-r2-3）

---

## 5. 委譲の割り当て

| 工程 | 担当 | 本プランでの具体 |
|---|---|---|
| 設計 | **Fable**（effort: high・本書は xhigh） | 束ごとの設計文書は**本設計で足りる**。足りなくなった束（S-editor の逆方向契約・A-document の byte 往復）だけ追補を Fable に |
| 設計のチェック | **main** | 実行フロー② |
| 実装 | **Codex**（`--model gpt-5.6-sol --effort high`・難所 = S-rpc の並行性・A-skeleton の 4 層またぎ配線は `xhigh`） | TS / Rust / Swift すべて Codex。🔴 **Swift のコンパイルが sandbox で通るかは N0-a で確かめ、通らなければ「Swift の build 確認は main」に固定** |
| 実装のモニタリング | **main** | 差分の中身を見る |
| **検証** | **main**（sandbox 外・実機） | 🔴 **N0 の 3 spike・IME・署名・GUI 起動・gated `native` はすべて main**。Codex の緑は根拠にしない（CLAUDE.md「検証を委譲先に任せない」） |
| レビュー | `/simplify` → `/code:pr-review-team` + **Fable 監査を並行**（束 PR で 1 回） | Fable への 3 問は固定（不在証明 = 設計 §5.3 の列挙表と実装の照合 / 外部 API の意味論 = `WKWebView` `URLSessionWebSocketTask` `NSDocument` の契約を一次ソースで / 横断的関心事 = D-4・D-5 の構造）。改訂（10-26）: 不在証明の問いに「**この束が足した暫定物（最終形でないまま動くもの）は、すべて台帳（設計 §1.4）に行と印があるか**」を足す — 印を付け忘れた暫定物は台帳の spec の検査 1 に掛からないため（設計 §13） |

**Codex へのブリーフに毎回入れるもの**（`consult-delegation` skill）: 触ってはいけない対象 = **`packages/vscode-extension/**` と `packages/engine/src/cli/repl-mode.ts`**（凍結）/ `rust/**`（裁定 2.4・engine 線の束は除く）/ 検証コマンド（`npm test` + `swift build` + 束の E2E 名）/ 報告形式（列挙表の `[x]`）。

**運用の知見（VSCodium 版 Phase 2・Serena `orbitstudio_phase2_spike_2026-07-07`）**: 長時間ビルドを subagent に detached で走らせると**完了通知が飛ばない**。`swift build` や `make-bundle.sh` を委譲する時は main が PID を監視する（memory `subagent-completion-notice-is-not-quiescence`）。

---

## 6. 裁定待ちが止める PR（一覧）

| 裁定（設計 §14） | 状態 | 止まる束 |
|---|---|---|
| (1) detach を第 1 リリースに含めるか | ✅ A（10-26） | **なし**（A なら何も足さない。B なら R-app の後に新束） |
| (2) `packages/engine` rename | ✅ A（10-26） | **なし**（A なら何も触らない） |
| (3) Node 同梱（W-22 引き継ぎ） | ✅ **A 同梱**（10-26 第 2 回。owner「nodeで評価する形にこだわっていません…特にタイミングなどの制御があるので」→ 設計 §4.6 の T-1） | **なし**（R-app は同梱で進める） |
| (4) タグ名前空間 / ワークフロー分割 | ✅ 案どおり（10-26） | **R-app の N4-b** |
| (5) 自動更新 | ✅ **B 含める**（10-26・推奨と異なる。既定で有効・opt-out） | **R-app**（N4 に自動更新の段が増える・設計 §9.3） |
| (6) Swift の CI | ✅ A + owner の条件（10-26・設計 §9.4: クラウドの作業は手元で引き継いでゲート。tag 時の GitHub は頻度とコストで決める） | **R-app の N4-b**（tag 時のみ）。手元ゲートは裁定不要 |
| (7) 拡張を薄いクライアントに | ✅ **書き直さない**（10-26 第 2 回。凍結のまま退役まで保つ） | なし（着手しない） |
| (8) 複数エディタ | ✅ A（10-26・1 クライアントが複数の document を持つ・設計 §5.4） | なし（1 つまでで実装） |
| (9) `protocol/` のライセンス | ✅ **定義だけ Apache-2.0**（10-26 第 2 回。owner の意見「DSLもApache-2.0でいい」の範囲 = DSL の仕様書だけ・#998 で扱う。実装 `packages/engine` はルートのライセンスのまま） | **S-rpc の N1-a1**（スキーマを置く PR に `protocol/LICENSE` を入れる・N-14） |
| (10) bundle id / 名前 / 配布物名 | ✅ A `com.signalcompose.orbitstudio`（10-26） | **R-app の N4-a**（初回署名の前） |
| (11) not-applicable の表面（改訂 10-23: `showCommands` を追加） | ✅ 推奨どおり 5 項目とも（10-26） | **A-parity の N3-c2**（それまで台帳は `native-required` として保持） |
| (12) issue 本文の出力先 `847` → `848` | main | なし |
| (13) ラックをリリースゲートに含める再確認 | ✅ 含める（10-26） | 🚪 の判定のみ |
| (14) app の版の正本 | ✅ A `apps/OrbitStudio/VERSION`（10-26） | **R-app の N4-a**（preflight）。それまで `0.1.0-dev` 固定で進める |
| (15) 同梱する文書の範囲（改訂） | ✅ A（10-26） | **R-app の N4-e**。それまで A の前提で `build-docs-bundle.mjs` を書いてよい（範囲は引数） |
| (16) 可用性表記の形（改訂） | ✅ A（10-26） | **docs の連続 PR ①**（§2.1 末尾）。文法が決まるまで章に書き込まない（後から全章を直すことになる） |
| (17) 凍結スナップショットの配信（改訂） | ✅ A（10-26） | なし |
| (18) ルーチンのトリガーと暫定行（改訂） | ✅ A（10-26） | **docs の連続 PR ③**。それまでルーチンは現状（PR マージ）のまま動く |
| (19) リリース後の docs 更新経路（改訂） | ✅ A（10-26） | なし（`--docs-dir` の複数指定は N-3 で先に入れる） |
| (20) user サイトの主語と host 依存段落の時期（改訂） | ✅ A + owner の条件（10-26: 拡張版の読者が OrbitStudio の記述を自分の手順として読まないこと・設計 §14.0） | **docs の連続 PR ②**（併記の書き方を条件に合わせて見直してから） |
| (22) 評価の単位（#987 Q2・改訂 10-23） | ✅ **閉じた**（10-26 第 2 回の項目 2・3: 移行は段階を分ける / 評価のかたちは **#997** の別の設計 / 要求に `target`） | **S-eval**（#997 の設計を待つ）。S-rpc / S-mcp は止めない（段階 1 の足場で進む） |
| (23) LLM へのトークンの渡し方（改訂 10-23） | ✅ **閉じた**（10-26 第 2 回の項目 4: 鍵の検査を残す / LLM は同梱の中継を 1 回だけ登録） | **S-mcp**（中継の小 PR が入る・§2.1） |
| 10-26 第 2 回の項目 1（パリティの再定義） | ✅ 提案どおり（関門 = DSL の実行結果と能力 / MCP ツールは v1 だけ / 区切り方・画面・ログの文言は参照 / 通信方式由来の制約は引き継がない） | **S-mcp の N1-b4**（台帳の分類の規則）・`evaluate_orbitscore` の改行禁止を写さない（N1-b1） |
| 10-26 第 2 回: T-1 の判断の閾値（設計 §14.0 Q-r2-2） | 提案値・main が確かめる | **なし**（N0-d は測って記録する。判定の行は閾値が決まってから） |
| 10-26 第 2 回: #996 の `release-gate`（設計 §14.0 Q-r2-3） | 推奨: 付ける・main | なし |
| (24) `.orbs` を 2 つ開いた時の共有（改訂 10-23・低優先） | ✅ A（10-26） | なし |
| (25) F-12 の自動再評価とプラグイン状態の喪失の伝え方（改訂 10-23） | ✅ (a) A・(b) A（10-26。「状態は復帰するが、実行は復帰しない」） | **A-skeleton の N2-a**（F-12 のアプリ側）。層 2 側（S-rpc）は裁定に依らない |

**今すぐ着手できる**: N0-a / N0-b / N0-c / 改訂（10-26）N0-d（裁定待ち 0）・S-rpc（(9) は裁定済み）・改訂: docs の連続 PR ①〜③ は (16)(18) の裁定が要る（推奨どおりなら即日）。改訂（10-26）: (16)(18) は A で裁定済み。② は (20) の条件に合わせて併記の書き方を見直してから（① に lint の規則 AV-HOST-SCOPE を入れる・設計 §1.4 の P-13）。**第 2 回の裁定で、owner 裁定待ちで止まる束は無くなった**（S-eval だけが #997 の設計を待つ）。

改訂（10-23）: **クラウド（Linux）に出せるのは S-rpc / S-mcp / S-editor の実装と unit**（§2.1 の「実行環境」列）。どれも受け入れの実機（headless の capture・gated）は macOS で main が回す。S-rpc の最初の小 PR は「評価の単位の写し + 差分テスト」（設計 §4.5.1）で、裁定待ち 0。改訂（10-26）: クラウドへ渡す順は §7 の作業列にまとめた（中継・S-eval を含む）。

---

## 7. 🔴 クラウドに続けて渡せる順の作業列（2026-10-26 新設・owner の全体への意見）

> 「可能ならこのあと出国する前にクラウドで一旦全通しくらいのつもりで作業を進めてもらって、帰国後に一緒にそれを確認できると有意義ですよね。」（owner・裁定シート第 2 回）

**「クラウドで全通し」が意味するもの**（期待を正確にしておく）: クラウド（Linux）で緑にできるのは **unit・差分テスト・中継の RL の検査・台帳の spec・`protocol:check` の TS 側**までで、**音は 1 つも出ない**（daemon・capture・音声デバイス・Swift・WKWebView・IME・署名はクラウドに無い・memory `cloud-credits-until-2026-11-05`）。クラウドの緑はマージの根拠にしない（設計 §14.0 (6)・CLAUDE.md「検証を委譲先に任せない」）。帰国後に手元で、各束の実機の検算（goldens・gated）を回して引き継ぐ。

**運び方**: クラウドは束ごとに統合ブランチを切り、小 PR を**前の小 PR の上に積んで**（stacked・draft）出す。手元で引き継ぐ時は**先端で**全テストと実機の検算を回してから、下から順にマージする（memory `stacked-pr-verify-at-the-tip`）。各束の**最初の手順は「束の issue を起票 → §2.1 の統合ブランチ名を更新」**（台帳 P-15 は仕組みを置けないので、手順で守る）。

### 7.1 クラウド（Linux）で続けて進める列

| # | 小 PR | 束 | 依存 | 完了条件（クラウドで緑にするもの） | 手元で後から確かめること |
|---|---|---|---|---|---|
| C-0 | 束の issue を起票し、統合ブランチ `<issue>-session-rpc` を切る | S-rpc | — | issue に「NMAP §4.A」・§2.1 の列を更新 | — |
| C-1 | **N1-a0** 足場の受付口 + 差分テスト（一致）+ 暫定物の台帳の仕組み + D-8 の follow-up | S-rpc | — | 差分テストがコーパス（複数行・未完・構文エラー・実行時エラー・空行 2 連・`evalBegin`/`evalEnd`・#607 / #612 / #614・#997 の検証ケース）で一致 / 台帳の spec が緑（`PROVISIONAL(P-01)` が台帳に在る）/ `planning-issue-state.spec.ts` が新地図と新計画を走査して緑 / `npm test` 緑 | 差分を main が読む・`npm test` を sandbox の外で回し直す |
| C-2 | **N1-a1** スキーマ（`target`・`socket` を含む）+ TS の生成 + `protocol:check`（TS）+ `protocol/LICENSE` | S-rpc | C-1 | `protocol:check` が差分ゼロ / スキーマに `x-surfaces` / `LICENSE` が Apache-2.0 の全文 | 🔴 **Swift 側の生成と往復は N0-b（手元）の後**（下の「暫定」）。生成ツールが N0-b で別のものに決まったら、TS 側も同じ PR で差し替える |
| C-3 | **N1-a2** WebSocket サーバ（UDS + TCP・同じハンドラ）+ 認証（TCP の Host / Origin〔欠落も拒否〕/ トークン・runtime-dir の権限・取り残しのソケット）+ engine の console 出力の受け取り（`PROVISIONAL(P-07)`）+ `engine.stop` の待ち | S-rpc | C-2 | D-10 の (1)〜(4) の unit（HTTP / WebSocket / UDS を実際に開く）/ 2 クライアント同時 attach・FIFO・version 不一致の拒否 / `log.line` の分類が凍結版の事例と一致 | macOS の UDS のパスの長さ（`~/Library/Application Support/…` で 103 文字以内か・退避先）を手元で 1 回 |
| C-4 | **N1-a3** `orbitscore session` CLI（ready 行・F-1 の機構・shutdown） | S-rpc | C-3 | stdin のパイプを閉じると終了 / `--parent-pid` が消えると終了 / ready 行の形（`socket` / `port` / `token`）/ F-12 の層 2 側（同じ引数で起動し直して document 一覧が戻る） | 🔴 **S-rpc の束の検算**: headless で `session.evaluate` → capture RMS > 0（実機）。束 PR のレビュー（`/simplify` → `/code:pr-review-team` + 監査）と owner の承認 |
| C-5 | 束の issue を起票し、統合ブランチ `<issue>-session-mcp` を切る | S-mcp | C-4 | — | — |
| C-6 | **N1-b1** MCP 層の移動 + `OrbitScoreToolHandlers` を RPC クライアントで実装（IM.6・改行禁止を写さない・`target.uri`） | S-mcp | C-5 | 移した MCP の unit（`mcp-server.spec.ts` 相当・`evaluate-document-directory.spec.ts` 相当〔改行のケースは「解決される」1 ケースに置き換え〕）が緑 | — |
| C-7 | **N1-b2** 中継 `orbitscore relay` + RL-1〜RL-8 の検査 + `session.registerMcp`（スタブの stdio 登録） | S-mcp（1,500 を超える見込みなら S-relay に切る） | C-6 | **D-10 の (6) と D-12 の unit**（層 2 を `kill -9` → 中継の PID が同じで次が通る / 層 2 なしで `tools/list` 28 本と `isError` / 再送しない / MAJOR 違い / `server/discover` に即答 / SIGINT で 100 ms 以内）/ 登録の形（`claude` CLI の呼び出しはテストで差し替え） | Claude Code（手元の CLI）に実際に登録して `/mcp` で見える・アプリなしで `tools/list` が出る |
| C-8 | **N1-b3** ハーネス: stdio の MCP クライアント + `ORBIT_GATED_TARGET=headless` + `ORBITSTUDIO_RUNTIME_DIR` + `--workspace-root` | S-mcp | C-7 | `vscode` ターゲットのテストが何も変わらない（型と unit）/ `ORBIT_GATED_*` が無ければ skip | 🔴 gated headless の**全件**（実機・goldens）は手元でしか回らない |
| C-9 | **N1-b4** パリティ台帳（56 題名・分類の規則）+ `mcp-tools-v1.spec.ts` | S-mcp | C-8 | 台帳の未分類 0 / `mcp-tools-v1.spec.ts` が緑（差は例外の表の 2 件だけ） | 🔴 **S-mcp の束の検算**: gated headless で goldens が 1 つも動かない・D-3・ERROR `<=`。束 PR のレビューと owner の承認 |
| C-10 | 束の issue を起票し、`<issue>-session-editor` を切る | S-editor | C-9 | — | — |
| C-11 | **N1-c1〜c3** document 同期・診断 / 補完 / subject-block / カーソル下のプラグイン解決・逆方向 `editor.*` と `NO_EDITOR_ATTACHED` | S-editor | C-10 | `editor.diagnostics` 通知と `get_diagnostics` の一致・subject-block の既存 unit を層 2 で再実行・IM.6 の第 2 候補が `didChangeActive` に従う | gated headless で `open_file` → `NO_EDITOR_ATTACHED`（実機） |
| C-12 | **#997 の設計の起案**（docs・`docs/design/997-…`） | #997 | C-1（差分テストのコーパスが検証ケースの土台） | #997 の完了条件（決めることすべてに答え・検証ケースの列挙・足場を置き換える PR の完了条件）が書かれている | 🔴 **owner と一緒に確かめる**（「バグ的な振る舞い」の例は owner にしか出せない）。S-eval の実装はこの後 |
| D-① | docs の連続 PR ①（可用性表記の文法 + `check-availability.mjs`〔AV-HOST-SCOPE を含む〕+ frontmatter `host:` の lint） | docs（main 直行） | — | lint が緑・規則 AV-HOST-SCOPE が在る（台帳 P-13） | — |
| D-② | docs の連続 PR ②（章の frontmatter と host 依存段落の併記） | docs | D-① | lint が緑 | 併記の読みやすさを owner が見る（(20) の条件） |

**クラウドで止まる所**: C-12 の後（S-eval は #997 の設計を owner が確かめてから）。D-③（ルーチンの手順を写す）は、手順の本文が cloud の routine の設定にあり、リポジトリから読めない（別冊 §7.1）ので手元で行う。

**暫定（台帳に足す）**: C-2 の `protocol:check` は、N0-b が済むまで **TS 側だけ**を検査する。最終形は TS と Swift の両方。台帳 **P-18**（設計 §1.4.1）で、`apps/OrbitStudio/Package.swift` が現れた時点で `protocol/gen/swift/` が空なら red にする。

### 7.2 帰国後に手元（macOS 実機）で行う列

| # | 作業 | 依存 | なぜ手元か |
|---|---|---|---|
| L-1 | **N0-d（T-1）**: タイミングの基準測定と判定の行 | — | capture と音声デバイス。**今のハーネスのまま測れる**ので最初に置ける。判定が「ゲート」なら PR-Q の位置が変わる（§4.2） |
| L-2 | **N0-a**: Monaco × WKWebView × IME（D-6 の ①〜⑤・owner 確認）・Origin の実測（3 配信元）・ATS・TextMate か Monarch か | — | WKWebView・IME・owner の実機確認 |
| L-3 | **N0-b**: 生成ツールの確定と TS ↔ Swift の往復（C-2 の暫定 P-18 を閉じる材料） | C-2 | Swift |
| L-4 | **N0-c**: SwiftPM → `.app` → 同梱 node → 署名・`spctl` / **スタブの解決の手段・App Translocation**（設計 §6.3）/ 中継の起動時間 | — | 署名・キーチェーン・Translocation |
| L-5 | S-rpc / S-mcp / S-editor の束の検算（C-4・C-9・C-11 の「手元で後から」）と、束 PR のレビュー・owner の承認 | C-4・C-9・C-11 | daemon・実音・gated |
| L-6 | S-eval（#997 の実装・段階 2）| C-12 と owner の確認・C-11 | 評価の実装と unit はクラウドにも戻せる。golden の検算は手元 |
| L-7 | A-skeleton → A-document → A-panels → A-parity | L-2〜L-5 | Swift・WKWebView・GUI。D-10 の T-2・D-12 の E4 の手の確認もここ（N2） |
| L-8 | R-app（署名・公証・自動更新・cold-install・`verify-app.sh` の release モード = D-11） | L-7 | 署名・公証・別アカウント |
| L-9 | D-③ ルーチンの手順を `DOCS_SYNC_ROUTINE.md` に写す（台帳 P-12） | D-② | cloud の routine の設定を読むのは手元 |

---

## 8. 更新履歴

| 日付 | 内容 |
|---|---|
| 2026-09-11 | 初版（#848・Fable 起案）。段 N0〜N4・束 9 本・一方通行 10 件・engine 線の付け替え表・裁定待ち 13 件 |
| 2026-09-18 | 改訂（Fable・effort high・main `1276ab1f`）。設計 §2b の判定に追従: S-mcp の中身（MCP 層 8 本 + `OrbitScoreToolHandlers`）/ S-editor に `plugin-ui-at-cursor` / A-panels の Docs パネルは同梱 docs / R-app に N4-e（docs 同梱・D-9）/ N-7 の理由（#878）/ N-13 / 裁定待ち (15)〜(20) / docs の連続 PR ①〜③。束の数と概算は据え置き（設計 §3.1 で移す量が初版と同じ桁と確認） |
| 2026-10-23 | 改訂（起案: fresh subagent / 審査: main・main `7410dcb0`・拡張 4.4.0）。設計 §2c の判定に追従: §2.1 に**束ごとの実行環境（Linux で完結 / macOS 実機が要る）**の列 / S-rpc に評価の単位の写し + 差分テスト・トークン + Origin・F-1 の機構・F-12 の層 2 側・状態を持たない `session.evaluate`・`transport.step` の `source`・`log.line` の `level` / `kind` / S-mcp に 28 本の順序・IM.6 の契約・`docs.*` の `site`・ハーネスのトークン経路・台帳の基準タグ v4.4.0（56 `it`）/ N0-a に Origin の実測（3 配信元）・ATS・D-6 の再現手順・Monaco の版の固定 / 「1 リクエスト = 1 `execute()`」を撤回（3 か所）/ #757・#777 は凍結版で CLOSED / 一方通行 N-1・N-3〜N-5 を更新 / 裁定待ち (22)〜(25)。束の数と概算は据え置き |
| 2026-10-26 | owner 裁定を §6 に反映（審査: main）。裁定済み 20 件（(5) 自動更新は **B 含める**に転じ、N4 に段を追加）・説明待ち 7 件（§4.7 の反転・§4.5.1・(3)・(7)・(9)・(22)・(23)）。詳細は設計 §14.0 |
| 2026-10-26（第 2 回） | 改訂（起案: fresh subagent / 審査: main）。owner 裁定 第 2 回を反映: 新しい束 **S-eval**（段階 2・#997）と §2.2 の 4 / N0-d（T-1・タイミングの基準測定）/ 暫定物の台帳（設計 §1.4・D-11）を S-rpc の N1-a0 で入れる / **中継**（S-mcp の N1-b2・設計 §6）・UDS・`--runtime-dir`・`ORBITSTUDIO_RUNTIME_DIR`（`ORBITSCORE_SESSION_TOKEN_FILE` と `--mcp` を削った）/ `protocol/LICENSE`（N-14）/ 一方通行 N-15・N-16 / 🚪 に D-11 と（T-1 がゲートなら）PR-Q / §6 の (3)(7)(9)(22)(23) を裁定済みへ / **§7 クラウドに続けて渡せる順の作業列**（C-0〜C-12・D-①②・手元の L-1〜L-9）を新設し、更新履歴を §8 へ。束の概算は S-rpc / S-mcp を約 1,300 に（未実測） |
