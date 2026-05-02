# OrbitScore Development Work Log - 2026-02 Archive

**Archive Period**: 2026-02
**Note**: This is an archived version of the work log. For recent work, see [../development/WORK_LOG.md](../development/WORK_LOG.md)

---

### 6.50 Issue #85: Fix audio relative path resolution (February 27, 2026)

**Date**: February 27, 2026
**Status**: ✅ COMPLETE
**Branch**: `85-fix-audio-relative-path-resolution`
**Issue**: #85

**Work Content**: Normal Mode でオーディオファイルの相対パスが `.osc` ファイルの場所ではなく `process.cwd()` を基準に解決されるバグを修正。`sequence.audio()` でパスを設定する時点で絶対パスに解決するようにした。

**Root Cause**: `sequence.audio()` が `globalState.audioPath` 未設定時に相対パスをそのまま保存し、`process-statement.ts` の RUN/LOOP が `process.cwd()` を基準に解決していた。Extension が注入する `setDocumentDirectory()` の `_documentDirectory` が使われていなかった。

**Changes**:
- `packages/engine/src/core/global/types.ts` — `GlobalState` 型に `documentDirectory` フィールドを追加
- `packages/engine/src/core/global/audio-manager.ts` — `getState()` で `documentDirectory` を返すように変更
- `packages/engine/src/core/sequence.ts` — `audio()` / `_audio()` で相対パスを `documentDirectory` を基準に絶対パスへ解決
- `packages/engine/src/interpreter/process-statement.ts` — RUN/LOOP のバッファプリロードで `documentDirectory` を使うフォールバックを追加

**Tests**: 225 passed, 23 skipped (all passing)

---

### 6.49 Issue #84: Include engine runtime deps in extension package (February 27, 2026)

**Date**: February 27, 2026
**Status**: ✅ COMPLETE
**Branch**: `84-fix-extension-engine-deps`
**Issue**: #84

**Work Content**: VS Code拡張パッケージにエンジンのランタイム依存関係（supercolliderjs, wavefile）が含まれていなかった問題を修正。

**Changes**:
- `scripts/install-engine-deps.sh` を新規作成（エンジン依存関係のインストール + パッチ適用）
- `packages/vscode-extension/package.json` の `build:engine` スクリプトに依存関係インストールステップを追加
- `.vscodeignore` から `engine/node_modules/**` の除外を解除
- `BUILD_GUIDE.md` を更新

**パッケージサイズ**: 93 KB → 3.3 MB（ランタイム依存を含む）

### 6.48 Issue #82: Fix scsynth boot timeout (February 27, 2026)

**Date**: February 27, 2026
**Status**: ✅ COMPLETE
**Branch**: `82-fix-scsynth-boot-timeout`
**Issue**: #82

**Work Content**: supercolliderjs の `Server.boot()` に3秒のハードコードタイムアウトがあり、scynthのデバイス初期化に3秒以上かかるとエンジンがクラッシュする問題を修正。

**Changes**:
- `scripts/patch-supercolliderjs.sh` を作成（タイムアウト 3s → 30s にパッチ）
- `package.json` に `postinstall` スクリプトを追加（`npm install` 時に自動パッチ）

---

### 6.47 Issue #80: Fix hardcoded input device in scsynth boot (February 27, 2026)

**Date**: February 27, 2026
**Status**: ✅ COMPLETE
**Branch**: `80-fix-hardcoded-input-device`
**Issue**: #80

**Work Content**: `osc-client.ts` の `boot()` で入力デバイス `'MacBook Airの'` がハードコードされており、外付けオーディオインターフェースが使用できない問題を修正。

**Changes**:
- `bootOptions.device = ['MacBook Airの', outputDevice]` → `bootOptions.device = outputDevice` に変更
- OrbitScoreは出力のみ使用するため、入力デバイス指定を削除
- scynthのデフォルト入力デバイスに委任

---

### 6.46 Issue #78: Migrate from Git Flow to GitHub Flow (February 27, 2026)

**Date**: February 27, 2026
**Status**: ✅ COMPLETE
**Branch**: `78-migrate-github-flow`
**Issue**: #78
**PR**: TBD
**Commit**: 1325935

**Work Content**: Git Flow（main + develop + feature branches）から GitHub Flow（main + feature branches）への移行。

#### 背景
- develop と main の内容が実質同一で、develop ブランチが形骸化していた
- ワークフローを簡素化し、GitHub Flow に一本化

#### 作業内容
1. **リモートブランチ削除**: マージ済み8本 + 未マージ31本 + develop = 40本
2. **develop ブランチ保護ルール削除**: GitHub API経由で保護ルールを解除後、ブランチ削除
3. **ドキュメント更新**:
   - `CLAUDE.md`: develop参照をすべて削除、GitHub Flowに書き換え
   - `docs/core/PROJECT_RULES.md`: ブランチ構造、ワークフロー、PR作成手順を更新
   - `CONTRIBUTING.md`: Git Flow → GitHub Flow に変更
4. **Hook スクリプト更新**:
   - `pre-edit-check.sh`: develop チェック削除（mainのみ保護）
   - `pre-commit-check.sh`: develop チェック削除
   - `session-start.sh`: develop 警告 → main 警告に変更
   - `hooks/README.md`: 説明を更新
5. **CI/CD更新**:
   - `claude-code-review.yml`: main PR除外条件を削除（全PRでレビュー実行）
6. **コミット戦略ルール追加**:
   - Conventional Commits 形式の採用を明記
   - 小さいコミットを積み重ねるルールを追加

#### 技術的決定
- squash merge の禁止ルールは維持（コミット履歴の保全のため）
- main ブランチの保護ルールはそのまま維持

---

