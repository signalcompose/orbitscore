# 設計: 配布 — ローカルリリースから署名・公証・cold-install まで（#659 / #656 / #385 / #138 / #498 / #197 / #184）

**対象 issue**: #659（ローカルリリースのスクリプト化）/ #656（署名・公証・リリース経路・`release-gate`）/ #385（workspace trust・`must-fix`）/ #138（cold-install 受け入れ）/ #498（Sentry）/ #197・#184（Marketplace・🔴 未決）
**関連**: `docs/planning/DEVELOPMENT_MAP.md` §3（`:217-262`）/ §4.J（`:1042-1060`）/ §6.1（`:1319`）/ §9（`:1451`）・`docs/research/EDITOR_HOST_AND_APP_SIZE.md`（アプリの実測・署名順序）・`docs/research/CODESIGN_PIPELINE.md`（SC 前提で古い）
**正本**: 本書は spec ではない。改訂対象の正本は `docs/research/CODESIGN_PIPELINE.md`（§13）と `sites/user/getting-started/installation.md`
**状態**: 設計（実装しない）・2026-09-03・main `ca176f0` 実測

---

## 0. 裁定・確定事項（再議論しない）

| # | 裁定 | 出どころ |
|---|---|---|
| 1 | **`.app` と `.vsix` の両方を出す**。`release.yml`（vsix 専用）は生きる。app の**ジョブを足す** | owner 2026-09-03・#656 コメント 1 / 地図 §3 `:250-258` |
| 2 | #656 本文の「**vsix は基本リリースしない**」は**撤回** | 同上 |
| 3 | **Marketplace / Open VSX 経由にするかは未決**。#197 / #184 は `release-gate` を外した（GitHub Releases だけなら PAT 不要） | owner「マーケットプレイスかはともかく、両方出す」/ 地図 §3 `:256-259` |
| 4 | 順序は **#659 → #656 → #498**。**#385 は独立で先にできる** | 地図 §4.J `:1057` |
| 5 | **#385 は `must-fix`**（利用者が到達できない）。リリース時期と無関係に直す | 地図 §3 `:243` / PROJECT_RULES §1b |
| 6 | 未署名の `.app` は quarantine で開けない。**署名・公証は配布の前提条件** | #656 本文 |
| 7 | 順序は **ビルド → トリム → 署名 → notarize → staple**。トリムを署名の後に置くと notarization が通らない | `EDITOR_HOST_AND_APP_SIZE.md:226-237`（実測 `codesign -v` 出力あり） |
| 8 | 自作エディタは**採らない**。VSIX + 軽量化 VSCodium 同梱 | 同 `:275`（owner 判断） |
| 9 | per-PR で macOS ランナーは回さない（コスト） | `rust-ci.yml:7-9,37-38`（owner 方針） |
| 10 | 手元の macOS が `bundle-macos.sh` + `--ignored` テストの**唯一の実行経路** | CLAUDE.md「マージ前ゲート」/ `rust-ci.yml:13-24` |

---

## 1. 到達点（1 文）

**新しい Mac で GitHub Releases から `OrbitStudio-<version>-darwin-arm64.dmg` を落として開き、初めて開くフォルダで `.orbs` を評価すると音が出る。** その `.app` は 1 本のスクリプトが作り、署名・公証まで通り、**同じ gated E2E がその成果物そのものに対して回る**。

---

## 2. 現在地（一次情報・本書が変えるもの）

| 事実 | 根拠 | 本書 |
|---|---|---|
| `capabilities.untrustedWorkspaces` の宣言が**無い** | `packages/vscode-extension/package.json`（grep 0 件・§10）| §3.2 で宣言する |
| `scope` を明示した 5 件はすべて `"machine-overridable"`（= **workspace settings で上書きできる**）。残りは既定 scope で同様 | `packages/vscode-extension/package.json:372,386,392,398,406`（`grep -c` = 5） | §3.2 で `restrictedConfigurations` を付ける |
| `orbitscore.scsynthPath` は**実行ファイルのパス**を受ける | 同 `:368-373` | 同上 |
| DSL の `instrument(path)` は**任意のパスのプラグイン**を読む（= 任意コード実行） | `packages/engine/src/core/sequence.ts:621-650` | §3.3 の脅威モデルの根拠 |
| 拡張は activate 中に MCP HTTP を `127.0.0.1` へ bind する | `extension.ts:451-456` → `mcp-server.ts:1339-1348` | §3.3・§12 の観測手段 |
| engine は **PATH の `node`** を spawn する（node は同梱していない） | `extension.ts:2159` | 🔴 §6.3 の cold-install 危険 |
| engine 本体は拡張内の `engine/dist/cli-audio.js` | `extension.ts:1084-1105` | 不変 |
| daemon は**同梱バイナリ**を最後の候補として解決 | `packages/engine/src/audio/rust-engine/daemon-client.ts:246-250` | 不変（署名対象・§5.1） |
| daemon は `127.0.0.1:0` に bind する | `rust/crates/orbit-audio-daemon/src/server.rs:19` | §5.3 の entitlements 論点 |
| child は `current_exe` の隣で解決する | `rust/crates/orbit-audio-daemon/src/outproc_effect.rs:453-456` | 署名は**バンドル単位**でよい |
| 同梱バイナリは 7 個 + `Gain.clap` | `scripts/copy-daemon-bin.sh:121-132` | §5.1 の全列挙 |
| `release.yml` の `paths` に **`rust/**` が無い** | `.github/workflows/release.yml:30-37` | §5.4 で足す |
| release.yml は今も `brew install --cask supercollider` して scsynth を焼く | 同 `:62-64` / `:104-110` | §5.4（#502 と衝突・裁定待ち (6)） |
| vsix 中身の検査は release.yml の**インライン shell にしか無い** | 同 `:116-207` | §4.5 で `scripts/verify-vsix.sh` へ切り出して両経路で共有 |
| `make-local-release.sh` は repo に**存在しない**（tracked でも untracked でもない） | `git ls-files \| grep -i release` / `ls scripts/*release*`（§10） | §4 で新規に書く |
| アプリのビルド作業場は **git 管理外** | `scripts/orbitstudio/README.md:21-22` / `build_orbitstudio.sh:12-20` | §5.4 の CI 化を塞いでいる（裁定待ち (3)） |
| 署名済みバンドルから消すと署名が壊れる | `EDITOR_HOST_AND_APP_SIZE.md:226-237` | 裁定 7 |
| 889 MB のうち 334 MB が source map | 同 `:131-151` | §4.2 段 3 |
| **`.vsix` が機能の 100%**・アプリ側に固有実装が 1 行も無い → app 版 = 拡張版 | 同 `:286-294` | §4.4 のバージョン規則の根拠 |
| `CODESIGN_PIPELINE.md` の結論は「**再署名しない**」（SC の署名を流用） | `docs/research/CODESIGN_PIPELINE.md:21-33` | 🔴 前提が消滅（§13） |
| 同 doc に `disable-library-validation` の記述は**無い**（entitlements の例は `network.server` / `network.client` / `device.audio-input` のみ） | 同 `:282` | 🔴 §5.3 は**未確認**として実測手順を置く |
| バージョンが 5 箇所でばらばら | `package.json:29`=1.1.0 / `packages/engine/package.json:3`=0.0.1 / `packages/vscode-extension/package.json:6`=2.1.0 / `packages/engine/src/version.ts:14`=2.0.0 / `rust/Cargo.toml:38`=0.0.1 | §4.4 |
| `publisher` が `local` | `packages/vscode-extension/package.json:5` | §8（Marketplace を採る時だけ変える・一方通行） |
| LICENSE は **source-available**（OSI ライセンスではない） | `LICENSE:1` | §8 の Open VSX 論点（#184 本文の GPL 記述は SC 時代で無効） |
| gated E2E は `--extensionDevelopmentPath` で**ソースから**拡張を読む | `tests/e2e/orbitstudio-mcp-gated.spec.ts:741` | §12 で「インストール済み」レーンを足す |
| app path は `ORBITSTUDIO_APP` で差し替えられる | 同 `:60-72` | §6.2 でリリース成果物を指す |
| harness は毎回新しい `--user-data-dir` / `--extensions-dir` を作る | 同 `:642-645` | §3.5 の trust 状態の固定点 |
| ユーザーサイトは「**他に何かをインストールする必要はありません**」と書いている | `sites/user/getting-started/installation.md:21-24` | 🔴 `node` 依存と矛盾（§6.3） |

---

## 3. #385 workspace trust（`must-fix`・独立して先にできる）

### 3.1 症状と機構

フォルダ無しの loose-file 起動（`orbs file.orbs`）は**未信頼の ad-hoc workspace** を作る。宣言の無い拡張は untrusted workspace で**制限付き**になり、**activate されない**。利用者には「何も起きない」ようにしか見えない（#385 本文・probe は `workspaceTrust.ts calculateWorkspaceTrust()` → `isEmptyWorkspace()` → `getUrisTrust(startupFiles)` をソース確認済み）。

**2 層で直す**（#385 本文の「対策（2 層）」そのもの）。層 1 は `.vsix` にも効き、層 2 は Claude Code 拡張（Anthropic 管理・`untrustedWorkspaces.supported: false` 宣言）まで救う。**両方要る。**

### 3.2 層 1: 拡張の宣言（`packages/vscode-extension/package.json`・`"engines"` `:31` の隣）

```jsonc
"capabilities": {
  "untrustedWorkspaces": {
    "supported": "limited",
    "description": "OrbitScore evaluates .orbs files by starting a native audio engine and loading audio plugins named by the score, so evaluation requires a trusted workspace. In an untrusted workspace the editor features (syntax, completion, docs) stay available and evaluation reports why it is blocked.",
    "restrictedConfigurations": [
      "orbitscore.scsynthPath",
      "orbitscore.engine"
    ]
  }
}
```

- **`"limited"` を選ぶ理由**: `false` は今日の挙動（黙って何も起きない）をそのまま宣言するだけで、**症状が直らない**。`true` は嘘になる — `instrument(path)`（`sequence.ts:621-650`）が譜面に書かれたパスの `.vst3` / `.clap` を child に読ませるので、**譜面を開くこと自体が任意コード実行**である。`limited` だけが「開けるが、走らせるには信頼が要る」を表現できる。**`true` か `limited` かは #385 本文が「要検討」としているので裁定待ち (1) に置く。**
- **`restrictedConfigurations` に入れる基準**: 「workspace が値を決めると**別の実行ファイルが動く**」もの。`orbitscore.scsynthPath` は実行ファイルのパスそのもの（`:368-373`）、`orbitscore.engine` は `sc` に倒すと `scsynthPath` を有効化する（`:374-387`）。
- **入れない**: `orbitscore.audioDevice` / `engineDebug` / `mcpServer.port` / `flash*` / `playheadPalette`。デバイス名・真偽値・ポート番号であって実行対象を選ばない。🔴 `audioDevice` を入れると **gated E2E harness が壊れる**（harness は workspace `.vscode/settings.json` に `orbitscore.audioDevice` を書く・`orbitstudio-mcp-gated.spec.ts:651-661`）。

### 3.3 untrusted で動かしてよい機能 / ダメな機能

判定の軸は「**外部から与えられたテキストが、プロセスの起動またはコードのロードを決めるか**」。

| 機能 | untrusted | 根拠 |
|---|---|---|
| 構文ハイライト・`language-configuration` | ✅ 可 | 宣言的・実行しない |
| DSL 補完 / メソッドカタログ / 診断 | ✅ 可 | `dsl-method-catalog.ts` / `diagnostics-analysis.ts` は純パース |
| 学習ビュー・docs パネル（`openDocs` / `search_dev_docs`） | ✅ 可 | 同梱アセットの表示 |
| プラグインカタログの**読み取り** | ✅ 可 | `~/.orbitscore/plugin-catalog.json`（`plugin-catalog-reader.ts:112`）= ユーザー領域。workspace は関与しない |
| **engine の spawn**（`node engine/dist/cli-audio.js repl`） | 🔴 不可 | `extension.ts:2159`。`cwd: workspaceRoot`・`.orbitscore.json` を読む（`:1130-1148`）。**プロセス起動そのもの** |
| **`.orbs` の評価**（`run_selection` / `evaluate_orbitscore`） | 🔴 不可 | 譜面が `instrument(path)` で任意 dylib を child に読ませる（`sequence.ts:621-650`） |
| **プラグインの rescan**（`orbit-plugin-scan` の spawn） | 🔴 不可 | `plugin-catalog-reader.ts:175-195` が別プロセスを起動する |
| **MCP サーバの bind**（`ORBITSCORE_MCP_PORT` / 設定 > 0） | 🔴 不可 | `extension.ts:451-456`。外部エージェントに `evaluate` / `start_engine` を開ける口なので、評価が不可なら口も開けない |
| プラグイン UI の表示（`open_plugin_ui`） | 🔴 不可 | engine 経由 = 上に従属 |

**実装の形**: 上表の 🔴 側の入口 1 箇所ずつに `vscode.workspace.isTrusted` のガードを置くのではなく、**engine を起動しうる唯一の関門**である `startEngine()`（`extension.ts:2044`）と MCP サーバ起動（`:456`）の 2 箇所に置く。評価は engine が無ければ進めない（`startEngine` 前提は `mcp-server.ts:562-565` の tool 説明どおり）ので、この 2 点で全 🔴 行が閉じる。

```ts
// extension.ts:2044 startEngine() の先頭（engineProcess の既存チェックの直後）
if (!vscode.workspace.isTrusted) {
  outputChannel?.appendLine(
    '⛔ Workspace is not trusted — the audio engine is not started. ' +
      'A score can name arbitrary plugin bundles to load, so evaluation requires trust.',
  )
  const pick = await vscode.window.showErrorMessage(
    'OrbitScore needs a trusted workspace to start the audio engine.',
    'Manage Workspace Trust',
  )
  if (pick) await vscode.commands.executeCommand('workbench.trust.manage')
  return false
}
```

🔴 **要点は「黙らない」こと。** #385 の実害は拒否ではなく**沈黙**である。拒否は `outputChannel`（= `get_log`・`log-ring.ts` 経由）と通知の**両方**に出す。

### 3.4 層 2: OrbitStudio 側（product.json override）

`build_orbitstudio.sh` の scope は「env と product.json の上書きだけ」（`:6-8`）で、上書きキーは **vscodium チェックアウト直下の product.json** に置く運用（同 `:6-8`）。**その override ファイルは git 管理外の作業場にしかない**（`README.md:21-22`）ので、trust の既定を入れると**owner のディスクにしか存在しない設定**になる。

したがって **override を repo に持ち込む**:

- 新規 `scripts/orbitstudio/product.overrides.json`（tracked）
  ```jsonc
  {
    "configurationDefaults": {
      "security.workspace.trust.enabled": false
    }
  }
  ```
- `build_orbitstudio.sh` の末尾（`:46` の `cd` の直前）で、このファイルを作業場の product.json override へコピーする 1 行を足す

**設定名の出どころ**: `security.workspace.trust.enabled` は #385 本文（2026-07-07 の IDE チャネル probe）が名指ししている。**VS Code 公式 docs では確認していない**（本セッションは `code.visualstudio.com` への egress が塞がれている）。反証方法は §15。

**専用アプリで trust を切ってよい理由**: `.vsix` が機能の 100% を持ち、アプリ側に固有実装が 1 行も無い（`EDITOR_HOST_AND_APP_SIZE.md:286-294`）= **OrbitStudio は「譜面を鳴らすために入れたアプリ」であって汎用エディタではない**。層 1 の `limited` は `.vsix` を素の VS Code に入れた利用者を守り、層 2 は専用アプリの UX を通す。**層 1 を省いて層 2 だけにしない** — `.vsix` も出す（裁定 1）以上、素の VS Code 経路が残る。

### 3.5 E2E で trust の状態をどう固定するか

harness は毎回**新しい `--user-data-dir`** を作る（`orbitstudio-mcp-gated.spec.ts:642-645`）ので、trust の許可リストは**毎回空**である。つまり trust の状態は「その時の既定」に丸ごと依存していて、**今どちらであるかを誰も固定していない**。

🔴 **未確認**: `--extensionDevelopmentPath` を渡した Extension Development Host で workspace trust が無効化されるか。今日 harness が通っている以上「事実上そうなっている」だけで、**根拠を確認できていない**（VS Code / VSCodium のソースも docs も本環境から読めない）。#385 本文が probe で `--disable-workspace-trust` を使って回避したと書いているので、**そのフラグが存在すること**だけが確認済みの事実である。

**固定の仕方（推測に依存しない形）**: 新しい `--user-data-dir` の **User 設定**へ明示的に書く。パスは `<user-data-dir>/User/settings.json`。

| レーン | 書く値 | 何を確かめるか |
|---|---|---|
| 既存 suite（レーン A） | `{"security.workspace.trust.enabled": false}` | 既存の全アサーションを**既定の変化から切り離す**。今日の緑が「たまたま」なのをやめる |
| #385 の E2E（レーン B） | `{"security.workspace.trust.enabled": true}` | untrusted のまま activate し、engine 起動が**声を上げて**拒否されること |

レーン B は `--extensionDevelopmentPath` ではなく**インストール済み拡張**で回す（§12・E2E-D1）。dev host が trust を素通しするなら、dev path のままでは #385 を再現できない。

---

## 4. #659 ローカルリリース — 1 本のスクリプトに固定する

### 4.1 現在地

`scripts/orbitstudio/make-local-release.sh` は **この repo に存在しない**（§10 の 2 本の確認コマンド）。地図 §4.J `:1046` は「untracked で作業中」と書いているが、それは **owner のディスク上**の話で、本設計は**中身を知らない**。したがって本節は #659 本文の「手でやったこと（成立を確認済み）」9 段と `EDITOR_HOST_AND_APP_SIZE.md` §4-§5 から**書き起こす**。#659 のチェックリスト「❓ 未確認: 内容が本文の手順を満たしているか」は、**この設計を実装する時に owner の版と突き合わせて解消する**（§16 (2)）。

### 4.2 段の並び

```
scripts/orbitstudio/make-local-release.sh [--sign] [--notarize] [--out <dir>]

 1 preflight   git が clean・`git rev-parse --short HEAD`・バージョン整合（§4.4）
 2 build       (cd packages/vscode-extension && npm run build)   ← 🔴 ルートの build ではない（§10）
               = install-engine-deps.sh + copy-daemon-bin.sh（`packages/vscode-extension/package.json:456`）
               + bash rust/crates/orbit-std-gain/bundle-macos.sh --release
 3 package     ワークスペース外のステージへ rsync → npm install --omit=dev → npx vsce package
               （hoist 対策: `scripts/orbitstudio/README.md:35-39` の手順）
 4 verify-vsix bash scripts/verify-vsix.sh <vsix>   ← §4.5。落ちたら exit 1
 5 stage-app   ditto <base OrbitStudio.app> <out>/<stamp>-<sha>-app/OrbitStudio.app
 6 trim        find <app> -name '*.map' -delete            （−334 MB・判断の余地なし）
               + 拡張の取捨（🔴 未確定 = 裁定待ち (4)。既定は**削らない**）
 7 embed       <app>/Contents/Resources/app/bin/orbs --install-extension <vsix> --force
               → 生成物を Contents/Resources/app/extensions/orbitscore/ へ ditto
 8 sign        --sign 無し: codesign --force --deep --sign - <app>（ad-hoc・トリムで壊れた署名の復旧）
               --sign 有り: §5 の Developer ID 手順（deep 署名は使わない・§5.2）
 9 notarize    --notarize 有りのときだけ（§5）
10 smoke       空の --extensions-dir で起動 → MCP が応答するか（応答しなければ exit 1）
11 manifest    MANIFEST.md 生成 + `latest` symlink 張り替え
12 prune       世代数の上限で古い退避を削除（🔴 未確定 = 裁定待ち (4)）
```

**順序は裁定 7 で固定**（6 → 8。トリムを署名の後に置くと notarization が通らない）。7（埋め込み）も**署名の前**でなければならない — 同じ理由（バンドルの中身が変わる）。

### 4.3 成果物の一覧

| 成果物 | 置き場 | 名前 |
|---|---|---|
| `.vsix` | `<out>/<stamp>-<sha>-app/` の隣 | `orbitscore-darwin-arm64-<version>.vsix`（`release.yml:114` の `--target` 由来・既存形） |
| `.app` | `<out>/<stamp>-<sha>-app/OrbitStudio.app` | 固定名（ディレクトリが素性を持つ） |
| `MANIFEST.md` | `<out>/<stamp>-<sha>-app/` | commit・バージョン・トリム内容・検証結果・戻し方 |
| `latest` | `<out>/latest` → 最新の `<stamp>-<sha>-app/` | symlink |
| 配布物（`--sign --notarize` の時だけ） | `<out>/<stamp>-<sha>-app/` | `OrbitStudio-<version>-darwin-arm64.dmg`（🔴 zip / dmg は裁定待ち (5)・**一方通行**） |

`<stamp>` = `YYYYMMDD-HHMM`、`<sha>` = `git rev-parse --short HEAD`（#659 本文「退避先の命名（`<日時>-`）を手で付けると素性が追えなくなる」への答え）。

### 4.4 バージョン同期

**規則**: `.app` は拡張を built-in 同梱するので **app 版 = 拡張版**（`EDITOR_HOST_AND_APP_SIZE.md:292-294`・#656 コメント 1）。したがって**正本は `packages/vscode-extension/package.json` の `version`**（`:6` = 2.1.0）。

| 場所 | 現在 | 規則 |
|---|---|---|
| `packages/vscode-extension/package.json:6` | 2.1.0 | 🔴 **正本**。`.vsix` / `.app` / タグの版はこれ |
| `packages/engine/src/version.ts:14` `ENGINE_VERSION` | 2.0.0 | **別軸**（セッションログの meta ヘッダ・`version.ts:1-13`）。同期しない。ただし preflight で「リリース時に `-dev` サフィックスが残っていないこと」だけ検査する（`version.ts:10-12` の運用） |
| `packages/engine/src/version.ts:17` `DSL_VERSION` | 1.1 | 別軸（spec 版）。同期しない |
| ルート `package.json:29` | 1.1.0 | `private: true`（`:3`）で配布物にならない。**放置すると読み手が混乱するので、正本を指すコメントか、正本と同値へ寄せる**（裁定待ち (7)） |
| `packages/engine/package.json:3` / `rust/Cargo.toml:38` | 0.0.1 | 内部パッケージ。同期しない |
| git tag | — | `v<正本>`。`release.yml:224` が bare SemVer だけ stable と判定する |

**preflight の検査（`exit 1`）**: `git describe --exact-match` があるとき、その tag が `v<拡張の version>` と一致すること。**これが無いと `vsce package` は package.json の版で焼くのに、GitHub Release は tag の版で作られ、静かにずれる**（`release.yml:114` と `:245-248` が別の値を見ている）。

🔴 **一方通行**: バージョン番号の付け方（正本をどこに置くか・app と vsix を揃えるか）は、一度リリースすると利用者の更新経路と Marketplace の版履歴に焼き付く。**裁定待ち (7)。**

### 4.5 検証ゲート — `scripts/verify-vsix.sh` を切り出して両経路で共有する

今日、出荷物そのものを見る検査は **`release.yml:116-207` のインライン shell にしかない**。#659 のステップ ③（焼く前に vsix の中身を grep で検証）を書くと、**同じ検査が 2 つの実装で存在する**ことになる。#654（`yaml` が hoist で抜け、ビルド緑・パッケージ成功・インストール成功のまま初回評価で落ちた）を捕まえたのはこの検査なので、**二重化して片方だけ腐る形にしない**。

**新規 `scripts/verify-vsix.sh <vsix|展開済みディレクトリ>`** に、`release.yml:134-207` の 4 検査をそのまま移す:

| # | 検査 | 移す元 |
|---|---|---|
| 1 | daemon が存在し実行可能 | `release.yml:134-147` |
| 2 | child 5 本が存在し実行可能 | `:149-160` |
| 3 | `orbit-plugin-scan` が存在し実行可能 | `:162-173` |
| 4 | `packages/engine/package.json` の `dependencies` が **全部** `engine/node_modules/` にある | `:175-189` |
| 5 | `std-plugins/Gain.clap` の bundle と `Contents/MacOS/Gain` | `:191-207` |
| 6 | **新規**: `engine/dist/cli-audio.js` が存在する（`extension.ts:1087` が唯一見るパス） | — |

`release.yml` 側は `bash scripts/verify-vsix.sh "$VSIX_CHECK"` の 1 行に置き換える（scsynth の `verify-bundle.sh` 呼び出し `:132` はそのまま残す）。

**smoke（段 10）の判定**: 「MCP が応答する」までを自動にする（#659 本文「最低限、空の extensions-dir で起動して MCP が応答するところまでを自動で確認する」）。**840 の演奏は含めない** — Kontakt のロードが重い（#659 本文）ため。代わりに**音の確認は §12 の gated E2E がリリース成果物に対して回る**ことで担保する（#659 本文の「『動く』の判定を起動の成否だけにしない」への答え）。

---

## 5. #656 署名・公証・リリース経路

### 5.1 署名対象の全列挙

| # | 対象 | 由来 | 今日の署名 |
|---|---|---|---|
| 1 | `orbit-audio-daemon` | 自前 | ad-hoc（#656 本文） |
| 2 | `orbit-effect-rack-child` | 自前 | ad-hoc |
| 3 | `orbit-clap-effect-child` | 自前 | ad-hoc |
| 4 | `orbit-clap-instrument-child` | 自前 | ad-hoc |
| 5 | `orbit-vst3-effect-child` | 自前 | ad-hoc |
| 6 | `orbit-vst3-instrument-child` | 自前 | ad-hoc |
| 7 | `orbit-plugin-scan` | 自前 | ad-hoc |
| 8 | `std-plugins/Gain.clap`（`Contents/MacOS/Gain`） | 自前 cdylib | ad-hoc |
| 9 | scsynth bundle（`scsynth` + plugins 26 + `libsndfile.dylib`） | SC project | **Developer ID 済**（`CODESIGN_PIPELINE.md:47-83`・team `HE5VJFE9E4`）。**再署名しない** |
| 10 | `engine/node_modules/**/*.node`（`@julusian/midi` の prebuilt） | 3rd party | 未確認 |
| 11 | OrbitStudio.app（Electron 本体・`Contents/Frameworks` 255 MB） | VSCodium | ビルド時の設定次第（未確認） |

1-8 は `scripts/copy-daemon-bin.sh:121-132` の全行。9 は `scripts/extract-scsynth-bundle.sh` の出力。

**署名の単位**: 1-8 は `.app` に埋め込まれる（`Contents/Resources/app/extensions/orbitscore/engine/bin/darwin-arm64/`）ので、**`.app` の署名がそれらを覆う**。`.vsix` として単体配布する経路では、**`.app` の外**に出るので個別の署名が要る（`.vsix` は zip だが Mach-O の `LC_CODE_SIGNATURE` は保存される・`CODESIGN_PIPELINE.md:172`）。

### 5.2 順序

```
build → trim → 内側から署名（深い順） → .app を署名 → dmg/zip を作る → notarytool submit --wait → stapler staple → 検証
```

- **`--deep` は使わない**（配布物に対して）。理由は本リポジトリの構成から出る: **内側のバイナリごとに entitlements を変えられない**（§5.3 の実測で 1-8 の一部だけに entitlement を足す可能性がある）。🔴 「Apple が deep 署名を非推奨としている」は**未確認**（§15）。`make-local-release.sh` の ad-hoc 段（`--sign` 無し）だけは `--deep` を使ってよい（`EDITOR_HOST_AND_APP_SIZE.md:177-184` の実測手順と同じ・配布しないため）
- 各バイナリ: `codesign --force --options runtime --timestamp --sign "$IDENTITY" [--entitlements <plist>] <path>`
- 認証情報: 署名は Keychain の `Developer ID Application: SIGNAL COMPOSE K.K. (ZWULF5LA37)`、公証は ASC API キー（`.p8`・1Password）で `xcrun notarytool submit --key/--key-id/--issuer`（#656 本文「手元にあるもの」）。**Apple ID とアプリ固有パスワードを CI に置かない**

🔴 **一方通行（明示）**:

| 事項 | なぜ戻せないか | 今の値 |
|---|---|---|
| **署名 identity（Team ID）** | Team ID が変わると macOS には**別の開発者のアプリ**。既存インストールは「アップデート」にならず、公証の履歴も引き継げない | `ZWULF5LA37`（#656 本文） |
| **`.app` の bundle id（`CFBundleIdentifier`）** | 変えると macOS 上は**別アプリ**。設定・TCC（マイク / ファイルアクセス）の許可・Gatekeeper の記録がすべてリセットされる | 🔴 **未確認**。`build_orbitstudio.sh` は `APP_NAME` 等しか上書きしていない（`:27-41`）ので VSCodium の既定のまま。**初回の署名リリース前に確定する**（裁定待ち (5)） |
| **標準プラグインの bundle id** | child は `std-plugins/<name>.clap` で解決し、ホストは id で状態を紐づける | `com.signalcompose.orbit-std-gain`（`rust/crates/orbit-std-gain/src/lib.rs:46`）。`bundle-macos.sh:12-13` が「名前を変えると解決が無言で外れる」と明記 |
| **配布物の名前** | 更新導線・ドキュメント・ユーザーのブックマークが名前に依存する | `.vsix` は既存形（`release.yml:114`）。`.app` の配布物名は未定（裁定待ち (5)） |

### 5.3 entitlements — 🔴 未確認

`docs/research/CODESIGN_PIPELINE.md:282` にある entitlements の記述は **`com.apple.security.network.server` / `network.client` / `device.audio-input` の 3 つだけ**で、しかも **scsynth（OSC / audio）用の例**である。**out-of-process child が 3rd-party の CLAP / VST3 を dlopen するために何が要るかは、このリポジトリのどこにも書かれていない。**`com.apple.security.cs.disable-library-validation` も **記述が無い**（grep 済み・§10）。

したがって**推測で plist を書かない**。決め方は**実測**である:

| 段 | やること | 判定 |
|---|---|---|
| 1 | entitlements **なし**で `--options runtime` 署名し、`.app` で 3rd-party プラグインを attach する | 動けば不要。動かなければ次へ |
| 2 | `log stream --predicate 'sender == "amfid" or eventMessage CONTAINS "code signature"'` を流しながら再現 | 拒否理由が出る |
| 3 | 拒否理由に応じた entitlement を **1 つずつ**足し、足すたびに実機で鳴らす | #656 本文「entitlements を決める（オーディオデバイス・ネットワーク・JIT の要否を 1 つずつ）」 |

**候補（仮説・確定ではない）**: 3rd-party dylib のロード（`disable-library-validation`）/ daemon の `127.0.0.1` bind（`server.rs:19`）/ マイク入力（今日は入力ストリーム 0 件・地図 §4.O.1 なので**不要のはず**）/ JIT（プラグインが使う可能性）。

🔴 **停止条件**: 段 1-3 で「entitlements を足しても 3rd-party プラグインが読めない」なら、**out-of-process 前提そのものが署名と衝突している**ので、実装へ進まず報告する（CLAUDE.md「Phase 0 の停止条件」と同じ扱い）。

### 5.4 `release.yml` の拡張

**(a) PR smoke に rust を通す**（`:30-37` の `paths`）:

```yaml
  pull_request:
    paths:
      - '.github/workflows/release.yml'
      - 'packages/vscode-extension/**'
      - 'packages/engine/**'
      - 'rust/**'                       # ← 追加。rust だけを触る PR で今日この job は走らない
      - 'scripts/**'                    # ← 追加。3 本を個別列挙していたので verify-vsix.sh 追加時に腐る
```

**理由**: `rust-ci.yml` は全ジョブ ubuntu（`:37-39`）で macOS 実装を 1 度も検証しない（同 `:13-24` が自認）。`release.yml` は macos-14（`:50`）なので、**rust の変更が macOS でパッケージまで通るかを見る唯一の CI 経路**である。それが `paths` から漏れている。

**(b) app ジョブを足す**（tag push のときだけ）:

```yaml
  app:
    name: Build, sign and notarize OrbitStudio.app
    needs: release
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: macos-14
    timeout-minutes: 120
    env:
      SIGN_IDENTITY: ${{ secrets.APPLE_DEVELOPER_ID_APPLICATION }}   # "Developer ID Application: SIGNAL COMPOSE K.K. (ZWULF5LA37)"
    steps:
      - Checkout
      - Import certificate  (secrets: APPLE_CERT_P12_BASE64 / APPLE_CERT_P12_PASSWORD → 一時 keychain)
      - Download the .vsix produced by the release job
      - Obtain the OrbitStudio base app        # ← 🔴 ここが未解決。裁定待ち (3)
      - bash scripts/orbitstudio/make-local-release.sh --sign --notarize --out "$RUNNER_TEMP/out"
        env: ASC_KEY_P8 / ASC_KEY_ID / ASC_ISSUER_ID
      - gh release upload "$TAG" "$RUNNER_TEMP/out/**/OrbitStudio-*.dmg"
```

**ジョブと `make-local-release.sh` は同じ 1 本を呼ぶ。** CI に別実装を書かない（#659 の投資を CI が二重化しないため）。

🔴 **未解決**: 「Obtain the OrbitStudio base app」。アプリのビルドは **VSCodium のチェックアウトの隣**で走る前提で（`build_orbitstudio.sh:12-20`）、その作業場は **git 管理外**（`README.md:21-22`）。CI で毎回 VSCodium をフルビルドするか、成果物を持ってくるかは**コスト方針の問題**なので裁定待ち (3)。**それまでは `.app` は手元で作って `gh release upload` する**（`.vsix` の CI は今日どおり動く）。

**(c) SC のステップ**: `:62-64`（`brew install --cask supercollider`）と `:104-110`（scsynth 抽出・検証）は今も走り、`.vsix` に ~11.5 MB の scsynth が入る。SC は退役済み（#502）だが**削除は #502 の範囲**なので本書では触らない。ただし **`brew install --cask supercollider` が壊れた日にリリースが止まる**ことは失敗モード表（§11）に載せる。

### 5.5 quarantine と受け取り側

`CODESIGN_PIPELINE.md:129-146` は「.vsix を展開したファイルに quarantine が付き、child の署名が online 検証される」と書いているが、これは **SC の署名済みバイナリを前提にした 2026-04-23 の記述**である。今日同梱するのは §5.1 の 1-8（ad-hoc）なので、**同じ経路が通る保証は無い**。`.app` 経路は quarantine がバンドルに付き Gatekeeper が起動時に検証する（#656 本文）。

**両方 §12 の E2E で実測する**（E2E-D3 が `xattr -w com.apple.quarantine` を明示的に付けてから開く）。

---

## 6. #138 cold-install — 受け入れ基準の書き直しと「同じ E2E を成果物へ」

### 6.1 受け入れ基準の書き直し

#138 の現行基準は **SC 前提**（scsynth boot 10 秒以内・`SuperCollider 3 server ready.` 等）。cutover #108 で既定が Rust daemon になり、SC-less は例外条件ではなく通常状態（#138 コメント 2）。書き直し:

| 旧（SC 前提・破棄） | 新 |
|---|---|
| SC.app / Homebrew 未導入の macOS で `.vsix` が動く | **署名・公証済みの `.app` を落として開き、初めて開くフォルダで音が出る** |
| scsynth boot が 10 秒以内 | **engine が起動し、`get_engine_state` が `running: true` を返す** |
| `.vsix` 内 scsynth が `codesign --verify` で valid | **同梱 8 個（§5.1 の 1-8）が `codesign --verify` で valid かつ notarize ticket が staple 済み** |
| vsce packaging 後も mode 0755 | 維持（`verify-vsix.sh` の検査 1-3） |
| Gatekeeper / quarantine で起動拒否されない | 維持。**quarantine を明示的に付けて確かめる** |
| Activation 時に bundle 不在の Notification が出ない | 維持 |
| — | **新規: `node` が PATH に無い環境でも音が出る、または失敗が声を上げる**（§6.3） |
| — | **新規: 初めて開くフォルダで評価できる**（#385 の受け入れそのもの） |

**統合先**: 地図 §6.1 `:1319` は「#138 → #656」、#138 自身の棚卸しコメントは「#659 と統合するのが自然」。**食い違いは地図 §9 `:1451` に未決として記録されている**ので、本書では埋めない（裁定待ち (2)）。**どちらに吸収しても本節の内容は変わらない**ので、実装は裁定を待たずに進められる。

### 6.2 同じ E2E をリリース成果物に対して回す

`ORBITSTUDIO_APP` でアプリのパスを差し替えられる（`orbitstudio-mcp-gated.spec.ts:60-72`）ので、**リリース成果物を指すことは今日すでにできる**。足りないのは 1 点だけ:

harness は拡張を `--extensionDevelopmentPath`（`:741`）= **リポジトリのソース**から読む。これでは「成果物に入っている拡張」を検証していない（`.app` に焼いた拡張ではなく、手元のソースを測る）。

**変更（`:737-745`）**:

```ts
const EXT_MODE = process.env.ORBIT_GATED_EXT_MODE === 'installed' ? 'installed' : 'dev'
// dev      : --extensionDevelopmentPath=<repo>   （既定・今日の挙動）
// installed: 事前に orbs --install-extension <vsix> --force --extensions-dir=<tmp> を実行し、
//            --extensionDevelopmentPath を渡さない（= .app に焼かれた拡張 or 入れた vsix が動く）
const extArgs = EXT_MODE === 'dev' ? [`--extensionDevelopmentPath=${EXTENSION_DEV_PATH}`] : []
```

`installed` では `ORBITSCORE_MCP_PORT` が効くこと（`extension.ts:451-455` は env を設定より優先する）が唯一の前提で、これは既に満たされている。**この 1 行の分岐で、既存の全アサーション（capture RMS・ラック期待値表・診断）がそのままリリース成果物の検証になる。**

### 6.3 🔴 `node` 依存 — cold-install で最初に壊れうる場所

`extension.ts:2159` は `child_process.spawn('node', [enginePath, ...args])` で **PATH の `node`** を呼ぶ。**node は `.vsix` にも `.app` にも同梱していない**（`.vscodeignore` にも `engine/` にも node ランタイムは無い）。一方ユーザーサイトは「**他に何かをインストールする必要はありません**」と書いている（`sites/user/getting-started/installation.md:21-24`）。

`docs/development/POST_2.0_ENGINE_AND_DISTRIBUTION.md:67` は殻の要素として「**node ランタイム**」を挙げており、**この問題は #301/#302 の時点で認識されていて、まだ解かれていない。**

**まず測る**（設計で決め打たない）: E2E-D3（§12）で PATH を launchd 既定相当（`/usr/bin:/bin:/usr/sbin:/sbin`）に絞って起動し、engine が起動するかを見る。

✅ **owner 裁定（2026-09-03 Q-656-8）: B node を同梱する**（サイズ + 署名対象 +1）。E2E-D3 は「同梱 node で起動する」ことの確認に読み替え、PATH の node には依存しない。同梱先は `.app/Contents/Resources/app/extensions/orbitscore/engine/bin/node`（`enginePath` の隣・§4.3 の成果物一覧に追加）、`extension.ts:2159` の `spawn('node', …)` を同梱パスへ（無ければ PATH へフォールバックし警告）。署名は §5.1 の内側リストに +1。以下の表は裁定前の分岐の記録:

| 結果 | 取る手 |
|---|---|
| 起動する | VS Code / VSCodium の shell env 解決が効いている。**ユーザーが node を持っていない場合**を別途 E2E で作る（PATH から node を外す） |
| 起動しない | 🔴 cold-install が原理的に成立しない。手は 2 つ: **(A)** `process.execPath` + `ELECTRON_RUN_AS_NODE=1` で Electron を node として使う（同梱ゼロ・Node 版はアプリに従属）/ **(B)** node を同梱する（サイズ増・署名対象が増える）。**A/B は裁定待ち (8)** |

**どちらに転んでも今すぐやること**: `getEnginePath()` の直後（`extension.ts:1084-1105` と同じ形）で **`node` の解決可否を pre-check し、無ければ声を上げる**。`startEngine()` は daemon については既に pre-check している（`:2078-2086`）のに、**その engine を走らせる node については何も見ていない** — 同じ形の穴である。

---

## 7. #498 Sentry — 位置づけ

**内容**（issue 本文・2026-07-17）: OrbitStudio / 拡張 / エンジン / daemon の 4 面のエラーを Sentry に集約する。段階は T1（Node 面）→ T2（Rust panic hook）→ T3（リリースパイプライン統合・同意 UI）。

**位置づけ**: 地図 §4.J `:1051` のとおり **#656 の後**。理由は本 issue 自身が書いている「リリース紐付け（version + commit SHA タグ・sourcemap upload・Rust の debug symbol）」で、**リリース経路が無いうちは紐づける先が無い**。

本書との接点は 3 点だけ:

| 接点 | 内容 |
|---|---|
| バージョン | Sentry の release タグは §4.4 の**正本**（拡張の `version`）+ `git rev-parse --short HEAD`。`MANIFEST.md`（§4.3）と同じ 2 つ |
| entitlements | daemon が Sentry へ送るなら `network.client` が要る可能性（§5.3 の実測に**含める**。今日の daemon は `127.0.0.1` のみ・`server.rs:19`） |
| ソースマップ | §4.2 の段 6 が `.map` を全削除する。**Sentry へアップロードするなら削除の前に取る**（削除は −334 MB で外せない） |

**本書はここまで**。T1-T3 の設計は #498 が持つ（本書で再設計しない）。

---

## 8. #197 / #184 Marketplace — 着手できるところまで

**確定している経路（裁定 1・3）**: `.vsix` は **GitHub Releases で出す**。これは今日すでに動く（`release.yml:232-248`）。**PAT も publisher アカウントも要らない。**

**したがって本書のスコープで着手可能なのは、Marketplace と無関係に必要な整備だけ**:

| 項目 | 状態 | Marketplace 依存 |
|---|---|---|
| GitHub Releases への `.vsix` 添付 | ✅ 動いている（`release.yml:245-248`） | なし |
| `PUBLISH_MARKETPLACE != 'true'` で publish が skip される | ✅ 設計済み（`:255` / `:272`）。secret が無ければ**声を上げて止まる**（`:263-266`） | なし |
| `.vsix` の中身検査 | §4.5 で共有化 | なし |
| icon / galleryBanner / README | ○ | **あり**（listing 表示用） |
| `publisher: "local"` → 実名 | ○（`package.json:5`） | **あり**・🔴 **一方通行**（publisher 名は後から変えると別拡張になり、インストール済みユーザーの更新が切れる） |
| `VSCE_PAT` / `OVSX_PAT` 登録 | 未登録（#197 コメント 1） | **あり** |

🔴 **#184 本文の前提が 2 つ壊れている**（着手時に本文を直す・PROJECT_RULES §1d の「変更」記法で記録する）:

1. 「同梱の **scsynth は GPL-3.0**」を軸にした節（listing への明記・アンインストール時の容量）は **SC 退役（#502）前の前提**。#184 コメント 2 が既に指摘済み
2. 本文が触れていない**本当の論点**: このリポジトリの LICENSE は **Signal compose Source-Available License v1.0**（`LICENSE:1`）= OSI ライセンスではない。**Open VSX / Marketplace の publisher 規約が source-available を許すかは 🔴 未確認**（本セッションからは egress が塞がれていて一次ソースを読めない）。反証方法は §15

**#197 / #184 の着手可否そのものは未決**（裁定待ち (6)）。

---

## 9. データの通り道 1 本（端から端まで）

```
[repo] git tag v<version>                                    ← 版の正本は packages/vscode-extension/package.json:6
  → .github/workflows/release.yml (macos-14)
      cargo build --release  ×4 + bundle-macos.sh            :86-93   → rust/target/release/{7 バイナリ, std-plugins/Gain.clap}
      cargo test -p orbit-effect-rack-child --lib -- --ignored :95-98  ← Gain.clap が実際に鳴るか
      npm run build (packages/vscode-extension)               :100-102 → install-engine-deps.sh（node_modules を hoist 外で作る）
                                                                       + copy-daemon-bin.sh:121-132（8 個を engine/bin/darwin-arm64/ へ）
      npm run build:bundle / verify:bundle                    :104-110 → scsynth（SC 署名を温存）
      npx vsce package --target darwin-arm64                  :112-114 → orbitscore-darwin-arm64-<version>.vsix
      bash scripts/verify-vsix.sh <展開>                       §4.5    ← 今日はインライン :116-207
      gh release create → .vsix を添付                         :232-248
  → [app ジョブ / または手元] make-local-release.sh --sign --notarize
      ditto base app → *.map 削除 → orbs --install-extension → Contents/Resources/app/extensions/orbitscore/
      codesign（内側 8 個 → .app）→ dmg → notarytool submit --wait → stapler staple
      gh release upload → OrbitStudio-<version>-darwin-arm64.dmg
[利用者] ダウンロード（quarantine が付く）→ 開く → Gatekeeper が公証を検証 → 起動
  → 拡張 activate（extension.ts:286）→ MCP を 127.0.0.1 に bind（:451-456・ポート設定時のみ）
  → フォルダを開く → workspace trust（層 2 で既定 off・§3.4）
  → run_selection → startEngine（:2044）→ isTrusted ガード（§3.3）
  → spawn('node', engine/dist/cli-audio.js repl)（:2159）  ← 🔴 node は PATH 頼み（§6.3）
  → engine が daemon を解決（daemon-client.ts:246-250 = extension-bundle）→ spawn
  → daemon が 127.0.0.1:0 に bind（server.rs:19）→ child を current_exe の隣から spawn（outproc_effect.rs:453-456）
  → child が std-plugins/Gain.clap を隣から解決 → 音
[E2E] ORBITSTUDIO_APP=<その .app> ORBIT_GATED_EXT_MODE=installed npm run test:e2e:gated
  → start_engine({capture_wav}) → run_selection → capture WAV の RMS で判定（§12）
```

---

## 10. 呼び出し元の全列挙（grep の出力を貼る）

```
$ grep -rn '"capabilities"' packages/vscode-extension/package.json
(出力なし = 宣言が存在しない)

$ git ls-files | grep -i release
.github/workflows/release.yml

$ ls scripts/*release* scripts/orbitstudio/
ls: cannot access 'scripts/*release*': No such file or directory
README.md
build_orbitstudio.sh
（→ make-local-release.sh は tracked でも untracked でも存在しない。地図 §4.J:1046 の「untracked で作業中」は owner のディスク上の話）

$ grep -rn "scripts/[a-z-]*\.sh\|bundle-macos.sh" .github/workflows/release.yml packages/vscode-extension/package.json package.json
.github/workflows/release.yml:35:      - 'scripts/extract-scsynth-bundle.sh'
.github/workflows/release.yml:36:      - 'scripts/verify-bundle.sh'
.github/workflows/release.yml:37:      - 'scripts/copy-daemon-bin.sh'
.github/workflows/release.yml:93:          bash rust/crates/orbit-std-gain/bundle-macos.sh --release
.github/workflows/release.yml:132:          bash scripts/verify-bundle.sh "$VSIX_CHECK/extension/engine/scsynth"
packages/vscode-extension/package.json:456:    "build:engine": "... && bash ../../scripts/install-engine-deps.sh && bash ../../scripts/copy-daemon-bin.sh",
packages/vscode-extension/package.json:457:    "build:engine:clean": "... && bash ../../scripts/install-engine-deps.sh && bash ../../scripts/copy-daemon-bin.sh",
packages/vscode-extension/package.json:458:    "build:bundle": "bash ../../scripts/extract-scsynth-bundle.sh",
packages/vscode-extension/package.json:459:    "verify:bundle": "bash ../../scripts/verify-bundle.sh",
package.json:11:    "build:copy-engine": "... && bash scripts/copy-daemon-bin.sh",
package.json:26:    "postinstall": "bash scripts/patch-supercolliderjs.sh",

$ grep -rn "disable-library-validation" docs/ rust/ packages/ scripts/ .github/
(出力なし = このリポジトリのどこにも記述が無い。§5.3 を「未確認」とする根拠)

$ grep -rn "workspace.trust\|untrustedWorkspaces" --include='*' . （node_modules / .git を除く）
./docs/planning/DEVELOPMENT_MAP.md
./docs/planning/2026-09-03-issue-triage.md
（= コードにも package.json にも一切無い。設定名の一次情報は #385 本文の probe だけ）

$ grep -rn "spawn('node'" packages/ tests/
tests/vscode-extension/engine-command-awaits.spec.ts:180:    expect(() => child_process.spawn('node', ['/unit-test/cli-audio.js', 'repl'])).toThrowError(
packages/vscode-extension/src/extension.ts:2159:    engineProcess = child_process.spawn('node', [enginePath, ...args], {
（= engine を起動する経路は本番 1 箇所。§6.3）
```

**ルート `npm run build`（`package.json:11`）は `install-engine-deps.sh` を呼ばない**が、`packages/vscode-extension` の `build`（`:456`）は呼ぶ。release.yml は後者を使う（`:100-102`）ので出荷物は守られている。**`make-local-release.sh` も後者を使うこと**（前者を使うと `engine/node_modules` が更新されず #654 が再発する）。

---

## 11. 失敗モード（握り潰される経路が無いこと）

| 状況 | 今日の挙動 | 本書の後 |
|---|---|---|
| `cargo build` が失敗したまま bundle する | `copy-daemon-bin.sh:115` が警告して**古いバイナリを焼く**（exit 0） | 変えない（best-effort 契約）。**`verify-vsix.sh` と E2E がリリース側の関門** |
| engine の runtime 依存が hoist で抜ける（#654） | `release.yml:175-189` が loud に止める。**手元経路には検査が無い** | `verify-vsix.sh` を両経路で呼ぶ（§4.5） |
| `Gain.clap` が同梱から落ちる | `release.yml:191-207` が止める。手元は素通り | 同上 |
| `engine/dist/cli-audio.js` が無い | 実行時に `showErrorMessage`（`extension.ts:1093-1101`）。**パッケージ時の検査が無い** | `verify-vsix.sh` の検査 6 |
| 拡張が `.app` に焼かれていない | 起動するので気づかない（#659 本文） | 段 10 の smoke（空 `--extensions-dir` で MCP が応答するか）が `exit 1` |
| トリム後に署名し忘れる | `codesign -v` が `code has no resources...`（`EDITOR_HOST_AND_APP_SIZE.md:226-231`） | 段 8 を無条件で通す + `codesign --verify` を段 8 の最後に置く |
| 公証に失敗（entitlements 不足） | `notarytool` が非 0 | 段 9 で `exit 1`。ログ ID を `MANIFEST.md` へ |
| 公証は通るが 3rd-party プラグインが読めない | 🔴 **今日は分からない**（署名した `.app` で鳴らしたことが無い） | §5.3 の実測 + E2E-D4（成果物に対する rack 検証） |
| `node` が PATH に無い | 🔴 **spawn が `ENOENT`。`setupErrorHandler`（`extension.ts:1661`）がログには出すが、利用者には「音が出ない」だけ** | §6.3 の pre-check（daemon と同じ形で loud に） |
| untrusted workspace | 🔴 **拡張が activate せず沈黙**（#385） | §3.2 の `limited` + §3.3 の loud な拒否 |
| tag と拡張の version がずれる | 🔴 **静かに別の版が出る**（`release.yml:114` は package.json、`:245` は tag） | §4.4 の preflight で `exit 1` |
| `brew install --cask supercollider` が壊れる | 🔴 **リリース job 全体が止まる**（`release.yml:62-64`・timeout 10 分） | 本書では触らない（#502 の範囲）。**失敗モードとして記録する** |
| quarantine 付きで daemon の exec が拒否される | 🔴 未確認（`CODESIGN_PIPELINE.md:129-146` は SC 前提） | E2E-D3 が明示的に `xattr -w` して確かめる |
| `.map` を消した後に Sentry の symbolication が要ると分かる | 取り返せない（削除済み） | §7 の接点 3（削除の前に取る） |

---

## 12. E2E（すべて MCP 経由・`tests/e2e/orbitstudio-mcp-gated.spec.ts`・`ok` に assert しない）

| # | シナリオ | 起動条件 | 判定 |
|---|---|---|---|
| **E2E-D1**（#385） | 拡張を **installed** で入れ、`<user-data-dir>/User/settings.json` に `{"security.workspace.trust.enabled": true}` を書き、**フォルダを開かず** `.orbs` を 1 本だけ引数に渡して起動 → `open_file` → `set_selection` → `run_selection` | `ORBIT_GATED_EXT_MODE=installed` | ① `pollInitialize` が 60s 以内に応答する（= **activate した**。`extension.ts:451-456` は activate 中に bind するので、応答＝活性化の直接証拠）② `get_log` に `Workspace is not trusted` を含む行が **1 行以上** ③ `get_engine_state` の `running` が `false` ④ ERROR 件数 `toBeLessThanOrEqual(errorsBefore + 1)` |
| **E2E-D2**（#385 の裏） | 同じ起動を `{"security.workspace.trust.enabled": false}` で | 同上 | `start_engine({capture_wav})` → kick fixture を `run_selection` → capture WAV の窓 RMS が**無音でない**（既存 `captureInstrumentScenario` の `rms()`・`:501-604` と同じ計算）・`get_log` に `not trusted` が **0 行** |
| **E2E-D3**（#138 cold-install） | **リリース成果物の `.app`** を新しい場所へ `ditto` し `xattr -w com.apple.quarantine "0181;0;OrbitScoreE2E;"` を付ける → 新規 `--user-data-dir` / `--extensions-dir` → `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin` 相当で起動 | `ORBITSTUDIO_APP=<成果物> ORBIT_GATED_EXT_MODE=installed` | ① 起動して MCP が応答 ② `start_engine({capture_wav})` → `get_engine_state.running === true` ③ kick fixture の capture RMS > 無音床 ④ ERROR 件数 `<=` before ⑤ 🔴 **ここで落ちたら §6.3 の分岐へ**（PATH に node が無い環境の再現がこの項目の主眼） |
| **E2E-D4**（署名後の 3rd-party ロード） | E2E-D3 の続きで、既存の rack 期待値表（`rack-chain-gain-expectations.ts`）と同じ譜面を評価 | 同上 | ラックの RMS 比が既存の期待値表と一致（**署名が child の dlopen を妨げていないことの直接証拠**）。#656 本文「署名後に実機で音を鳴らし直す」の自動化 |
| **E2E-D5**（成果物の同一性） | `verify-vsix.sh` を `.app` に焼かれた拡張ディレクトリ（`Contents/Resources/app/extensions/orbitscore/`）に対して実行 | — | exit 0。**vitest からではなく `make-local-release.sh` 段 10 の一部**（`.app` の中身も vsix と同じ検査を通る） |

**共通の作法**（CLAUDE.md / `gated-assertion-hygiene.spec.ts`）:
- `evaluate_orbitscore` の `ok` に assert しない。判定は `get_log` と **capture の数値**
- ERROR 件数は `toBeLessThanOrEqual`（500 行窓・`gated-assertion-hygiene.spec.ts:30-45`）
- capture したら必ず `rms` を見る（同 `:46-57`）
- **新しい DSL 語を足さない**ので `dsl-e2e-coverage.spec.ts` の baseline は**変化なし**

**ハーネスに要る変更は 2 点だけ**（§3.5・§6.2）: `ORBIT_GATED_EXT_MODE` の分岐（`:737-745`）と、`<user-data-dir>/User/settings.json` を書く 3 行（`:642-645` の直後）。**並行機構は作らない。**

🔴 **E2E-D3 / D4 はリリース成果物が要る**ので、`make-local-release.sh` が出来るまで書けない。**先に書いて red を確認する**のは D1 / D2（trust）で、これは成果物なしで成立する。

---

## 13. spec / docs 改訂（実装より先）

| 対象 | 改訂 |
|---|---|
| `docs/research/CODESIGN_PIPELINE.md` | 🔴 **全面改訂**。「決定サマリ」表（`:21-33`）の「再署名しない / Apple Developer ID 不要 / Apple secret ゼロ」は**すべて無効**（SC 退役 #502・同梱 8 個は自前）。`:271-286` の "Fallback plan" が**本線**になったので本文へ昇格。`Last verified` を更新し、**entitlements の節は §5.3 の実測結果が出るまで「未確定」と明記する**（推測の plist を書かない） |
| `scripts/orbitstudio/README.md` | 「リリース」節（`:45-48`）を `make-local-release.sh` の使い方へ差し替え。`build_orbitstudio.sh` と `make-local-release.sh` の役割分担（前者 = ベースアプリ、後者 = 配布物）と `product.overrides.json`（§3.4）を書く |
| `sites/user/getting-started/installation.md`（+ `en/`） | ① `.app` の入手経路を最上段に足す ② 🔴 `:21-24`「他に何かをインストールする必要はありません」を §6.3 の実測結果に合わせる（node が要るなら書く／要らなくなったならそのまま）。翻訳は `TRANSLATION_STATUS.md` で当該章を `outdated` に |
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | **改訂なし**。本書は DSL 表面を 1 語も足さない（運用規則 7 の対象外） |
| `docs/planning/DEVELOPMENT_MAP.md` §4.J | `make-local-release.sh` の現在地を「**repo に存在しない**」に訂正（`:1046` は「untracked で作業中」= owner のディスクの話であり、リポジトリの状態ではない） |
| #138 / #184 の issue 本文 | §6.1 / §8 のとおり書き直す。**チェックリストは PROJECT_RULES §1d の記法**（消さず取り消し線 + 理由 + 出どころ） |

---

## 14. PR 分割

| PR | 内容 | 対象チェックリスト | 触る所（概算） | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|---|
| **PR-T1** `fix(studio): declare untrusted-workspace capability and refuse loudly` | §3.2 の宣言 / §3.3 のガード 2 箇所 / §3.5 のハーネス設定書き込み / E2E-D1・D2 | #385 全項目 | `package.json` +12 / `extension.ts` +25 / gated spec +60 | なし（**先に着手できる**・裁定 4） | E2E-D1・D2。実機: 新しいフォルダを初めて開いて評価（#385 の受け入れ） | **`supported` の値**（裁定待ち (1)） |
| **PR-T2** `feat(studio): default workspace trust off in the OrbitStudio build` | §3.4 の `product.overrides.json` + `build_orbitstudio.sh` 1 行 | #385 の層 2 | 新規 +8 / `build_orbitstudio.sh` +3 | PR-T1（宣言が先） | 実機: アプリを焼き直して loose-file 起動 | product.json のキー |
| **PR-R1** `refactor(release): extract the vsix content gate into a shared script` | §4.5（`verify-vsix.sh` 新規 + `release.yml` の置換 + 検査 6 追加） | #659 の ③ | 新規 +90 / `release.yml` −75 +2 | なし | CI の PR smoke が緑（`release.yml` の PR レーンがそのまま検査になる） | — |
| **PR-R2** `ci(release): run the smoke lane for rust and scripts changes` | §5.4 (a) の `paths` 2 行 | #656 の CI 項 | `release.yml` +2 | PR-R1 | この PR 自身が `scripts/**` に触るので**自分で発火する** | — |
| **PR-R3** `feat(build): script the local release end to end` | §4.2 の 12 段 / §4.3 の成果物 / §4.4 の preflight / §4.5 の段 10 / `README.md` 改訂 | #659 のほぼ全項目 | 新規 +260 / `README.md` +30 | PR-R1（段 4 が呼ぶ） | **手元で 1 回通す**（#659 コメント 1 の 🔴 項目）。成果物に対して E2E-D3 | **成果物の名前・退避先の構造** |
| **PR-R4** `feat(release): sign and notarize OrbitStudio.app` | §5.1-5.3 の署名段 / entitlements（実測後） / `CODESIGN_PIPELINE.md` 改訂 | #656 の署名・公証・実機確認 | `make-local-release.sh` +90 / 新規 plist / `CODESIGN_PIPELINE.md` 全面 | PR-R3 | E2E-D4（署名済み `.app` で 3rd-party が鳴る）。**§5.3 の停止条件あり** | 🔴 **署名 identity・bundle id**（裁定待ち (5)） |
| **PR-R5** `ci(release): publish the signed app on tag push` | §5.4 (b) の app ジョブ | #656 の CI 項 | `release.yml` +45 | PR-R4 + 裁定待ち (3) | tag を打って 1 回通す | 配布物名 |
| **PR-C1** `test(e2e): run the gated suite against the release artifact` | §6.2 の `ORBIT_GATED_EXT_MODE` / E2E-D3・D4 / #138 の基準書き直し | #138 全項目 | gated spec +80 / issue 本文 | PR-R3 | E2E-D3 が実際に落ちるか（PATH を絞って） | — |
| **PR-C2** `fix(studio): pre-check the node runtime before spawning the engine` | §6.3 の pre-check（+ 結果次第で A/B） | #138 の新規基準 | `extension.ts` +30 | PR-C1（測ってから） | E2E-D3 の PATH 絞り | 🔴 A（Electron を node として使う）を採るなら**一方通行**（裁定待ち (8)） |

**先に着手できるのは PR-T1 / PR-R1 / PR-R2**（裁定待ち 0 件）。

---

## 15. 確信度と反証方法

| 主張 | 確信度 | 反証方法 |
|---|---|---|
| `limited` にすれば loose-file でも activate する | 中 | PR-T1 の E2E-D1。応答しなければ宣言だけでは足りず、層 2（§3.4）が唯一の手になる |
| 🔴 dev host（`--extensionDevelopmentPath`）で trust が素通しされている | **低（未確認）** | `<user-data-dir>/User/settings.json` に `enabled: true` を書いて既存 suite を回す。緑のままなら dev host は素通し、赤になれば trust が効いている。**どちらでも §3.5 の「明示的に書く」で固定できる**ので設計は変わらない |
| `security.workspace.trust.enabled` という設定名 | 中（出どころは #385 本文の probe のみ） | VS Code / VSCodium の設定 UI で `security.workspace.trust` を検索するか、`code --list-extensions` を持つ実機で `settings.json` に書いて効くか見る。**egress が塞がれている本セッションでは docs を読めない** |
| entitlements 無しの hardened runtime で 3rd-party CLAP/VST3 が読める | **低（未確認）** | §5.3 の段 1-3。`CODESIGN_PIPELINE.md` に記述が無いので推測しない |
| quarantine 付きの `.app` から daemon / child が exec できる | 低〜中 | E2E-D3。`CODESIGN_PIPELINE.md:129-146` は SC の署名済みバイナリ前提の記述で、自前 ad-hoc には当てはまらない |
| `node` が cold-install で解決できない | **中（未測定）** | E2E-D3 の PATH 絞り。VS Code の shell env 解決が効けば通るが、**node を持たない利用者**は別途 red になる |
| `verify-vsix.sh` の切り出しで検査が弱まらない | 高 | 切り出し後に `release.yml` の PR smoke が緑。さらに `engine/node_modules/yaml` を意図的に削って `exit 1` になることを 1 回だけ確かめる（#654 の再現） |
| app 版 = 拡張版が成立し続ける | 高 | `EDITOR_HOST_AND_APP_SIZE.md:286-294`（アプリ側に固有実装 0 行）。**workbench を直接いじった瞬間に崩れる**（同 `:296-299`） |
| Open VSX / Marketplace が source-available ライセンスを許す | **不明（未確認）** | 各 publisher 規約を一次で読む。#184 に着手する時の最初の作業 |
| `codesign --deep` が配布物に不適 | 中（本書は repo 内の理由だけで判断） | Apple の `codesign` man / Notarizing docs を一次で読む（本セッションは egress が塞がれていて読めない）。仮に非推奨でなくても、entitlements を分けられない制約は残るので結論は変わらない |

---

## 16. 🔴 owner 裁定待ち（これ以外は着手できる）

> **2026-09-03 owner 回答（裁定シート Q-656-1〜8）**
> - (1) 🔴 **相談中**（owner「相談したい」）。チャットで提示: `"limited"` を推す理由 = `instrument(path)` が任意 dylib を読む・untrusted では engine を起動せず「信頼してください」を 1 クリックで出す。`true` にすると信頼ダイアログは出ないが、untrusted フォルダの譜面が任意コードを走らせる
> - (2) 🔴 **相談中**（owner「リリースの話は別ラインとして扱いたい」）→ #138 は**独立のまま（C）**で、リリース系 issue（#659 / #656 / #138 / #498）を `IMPLEMENTATION_PLAN` 段 8 = 別ラインとして扱う
> - (3) **C**（`.app` は手元・CI は upload だけ → B へ）
> - (4) **A 提案どおり**
> - (5) **A dmg・bundle id は VSCodium 既定**（一方通行・確定）
> - (6) **B GitHub Releases だけ（一旦）**
> - (7) **A 拡張の `version` を正本**（一方通行・確定）
> - (8) **B node を同梱**（推奨「測ってから」から変更）→ §6.3 改訂・PR-C2 は「同梱 + フォールバック警告」

| # | 問い | 選択肢 | 推奨 | 影響範囲 |
|---|---|---|---|---|
| (1) | `capabilities.untrustedWorkspaces.supported` の値 | **A** `"limited"`（activate する・engine と評価は拒否）/ **B** `true`（全部許す） | **A**。`instrument(path)` が任意 dylib を読む（`sequence.ts:621-650`）ので `true` は嘘になる。#385 本文が「`limited` + 制約明記 or `true` の選択は要検討」としている | PR-T1 の `package.json` 1 ブロック。B なら §3.3 のガードが不要になる |
| (2) | 🔴 **#138 の吸収先**（地図 §9 `:1451` の未決・**本書では埋めない**） | **A** #656 へ吸収（地図 §6.1 `:1319`）/ **B** #659 と統合（#138 コメント 2）/ **C** 独立のまま | 判断しない。**§6 の内容はどちらでも変わらない**ので実装は待たなくてよい | issue の開閉のみ |
| (3) | app ジョブのベースアプリをどう得るか | **A** CI で VSCodium をフルビルド（tag 時のみ・macos-14・~1h）/ **B** ベースアプリを別リリースに置いて CI が取得 / **C** `.app` は手元で作り `gh release upload` だけ CI | **C を phase 1**（ビルド作業場が git 管理外・`README.md:21-22`）→ B。A は owner のコスト方針（`rust-ci.yml:37-38`）と正面から衝突する | PR-R5 の有無。C なら PR-R5 は「upload だけ」に縮む |
| (4) | 退避先の既定・世代上限・**削る拡張の取捨** | 退避先 `~/Src/proj_orbitscore/orbitstudio-local-builds/`（#659 本文）/ 世代数 / `EDITOR_HOST_AND_APP_SIZE.md:243-260` の 21 個（うち `typescript-language-features` と `mermaid-markdown-features` は要検討・同 `:262-264`） | ソースマップ削除（−334 MB）は**判断の余地なし**なので既定で入れる。**拡張の削除は既定 off**（`--trim-extensions` で opt-in）。`840/perform/cue.ts` を編集するなら TS 拡張は要る | `make-local-release.sh` 段 6 と 12 |
| (5) | 🔴 **一方通行**: 配布物の形と名前、`.app` の bundle id | 形: **A** dmg / **B** zip。id: 未確認（VSCodium 既定のまま） | **dmg**（macOS の一般的な導線・ドラッグ&ドロップで Applications へ）。bundle id は**初回署名リリースの前に**確定する — 後で変えると別アプリ扱いで TCC 許可も設定も失われる | PR-R4 / PR-R5・利用者の更新導線 |
| (6) | Marketplace / Open VSX へ出すか（#197 / #184） | **A** 出す（publisher 登録 + PAT 2 本 + `publisher: "local"` を実名へ・**一方通行**）/ **B** GitHub Releases だけ | 判断しない（owner「かはともかく」= 明示的に保留された）。**B のままでもリリースは成立する**（裁定 3） | `package.json:5` / repo secret / #184 本文の書き直し |
| (7) | 🔴 **一方通行**: バージョン番号の付け方 | **A** 拡張の `version` を正本にし tag と一致を強制（§4.4）/ **B** ルート `package.json` を正本に / **C** 現状のまま（5 箇所ばらばら） | **A**。app 版 = 拡張版が構造的に成立している（`EDITOR_HOST_AND_APP_SIZE.md:292-294`）。C は「静かに別の版が出る」（§11） | `make-local-release.sh` の preflight・ルート `package.json:29` の扱い |
| (8) | `node` をどう確保するか（**§6.3 の実測後に判断する**） | **A** `process.execPath` + `ELECTRON_RUN_AS_NODE=1`（同梱ゼロ・Node 版はアプリ依存）/ **B** node を同梱（サイズ + 署名対象 +1）/ **C** 何もせず「node が要る」と文書化 | **測ってから**。E2E-D3 が緑なら C で足り、赤なら A を推す（B は §5.1 の署名対象を増やす） | `extension.ts:2159`・`sites/user/.../installation.md:21-24` |

