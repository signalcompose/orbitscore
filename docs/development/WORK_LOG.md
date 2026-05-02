# OrbitScore Development Work Log

## Project Overview

A design and implementation project for a new music DSL (Domain Specific Language) independent of LilyPond. Supports TidalCycles-style selective execution and polyrhythm/polymeter expression.

## Development Environment

- **OS**: macOS (darwin 24.6.0)
- **Language**: TypeScript
- **Testing Framework**: vitest
- **Project Structure**: monorepo (packages/engine, packages/vscode-extension)
- **Version Control**: Git
- **Code Quality**: ESLint + Prettier with pre-commit hooks

---

## Recent Work

### 6.66 Issue #137: Marketplace + Open VSX automated publish workflow (May 02, 2026)

**Date**: May 02, 2026
**Status**: ✅ COMPLETE (workflow file 完成、secrets 登録は user 作業)
**Branch**: `137-marketplace-publish-workflow`
**Issue**: #137 (Epic #131 Phase 1 — ICMC v1.0)

**Work Content**: PR #155 (Issue #136 scsynth bundle) マージ完了後の release 自動化。tag push (`v*`) trigger で GitHub Release / VS Code Marketplace / Open VSX に自動 publish する workflow を追加。`-rc` / `-alpha` / `-beta` suffix の prerelease tag は GitHub Release のみ自動化、Marketplace と Open VSX は stable tag のみ。

**実装**:
- `.github/workflows/release.yml` 新規作成 (macos-14 runner)
- pipeline:
  1. checkout + setup-node
  2. `brew install --cask supercollider` (bundle source)
  3. `npm ci` + `npm run build` (engine + extension)
  4. `npm run build:bundle` (scsynth 抽出)
  5. `npm run verify:bundle` (pre-package integrity gate)
  6. `npx vsce package --target $VSIX_TARGET --no-yarn` (currently `darwin-arm64`、env var で集約)
  7. `.vsix` 解凍 → verify-bundle.sh で **post-package signature 維持**確認
  8. tag で release type 判定 (stable iff `^v[0-9]+\.[0-9]+\.[0-9]+$`、それ以外は test/smoke tag も含めすべて prerelease 扱い)
  9. `gh release create` (prerelease/stable + `--generate-notes` で auto changelog)
  10. stable のみ `vsce publish` + `ovsx publish`
  11. GitHub Actions job summary に release 情報

**Security 対策**: `${{ github.ref_name }}` を直接 `run:` で展開せず `env:` 経由で shell 変数として参照 (workflow injection 緩和、参照: github.blog/security/vulnerability-research/)。

**必要 secrets** (user 作業):
- `VSCE_PAT`: VS Code Marketplace publisher token (Azure DevOps PAT)
- `OVSX_PAT`: Open VSX namespace token (Eclipse Foundation アカウント)
- **Apple Developer ID 不要** — SC project の既存 notarized signature を流用 (`docs/research/CODESIGN_PIPELINE.md` で確定)

**動作シナリオ**:
- `git tag v1.1.0 && git push origin v1.1.0` → 全 channel publish
- `git tag v1.1.0-rc4 && git push origin v1.1.0-rc4` → GitHub Release prerelease のみ
- 既存の手動 prerelease (rc1-rc3) も同パイプラインで再現可能

**後続**:
- user による secrets 登録 (`gh secret set VSCE_PAT --repo signalcompose/orbitscore` 等)
- 初回 publisher 取得 (Signal compose、Marketplace + Open VSX)
- 動作確認: 試験 tag (`v0.0.0-test1` 等) で workflow が走るか smoke

---

### 6.65 Issue #136: scsynth bundle integration in vscode-extension (May 02, 2026)

**Date**: May 02, 2026
**Status**: ✅ COMPLETE (PR pending review)
**Branch**: `136-bundle-scsynth-vscode-extension`
**Issue**: #136 (Epic #131 Phase 1 — ICMC v1.0)

**Work Content**: ICMC 2026 リリースの最大インストール障壁 (SC.app の手動 install 強要) を解消するため、scsynth + 26 plugins + libsndfile.dylib (~11.5MB) を `.vsix` に同梱、path resolver を extension/engine 共通化、bundle 不在時の first-run UX を実装。旧 #146 の (1)(2) (bundle 検出 + Notification) を統合 (CodeX レビュー承認、#146 close 済)。

**Version**: 1.0.1 → **1.1.0** (Phase 13 で minor bump、scsynth bundle 同梱は major feature)

**実装** (18 commits、各単独で `npm test` 通過):

| # | Commit | 内容 |
|---|--------|------|
| 1 | `63e298b` | feat(audio): add scsynth path resolver with multi-source fallback |
| 2 | `24a2e5c` | refactor(audio): wire SuperColliderPlayer through scsynth resolver |
| 3 | `a4bad3b` | feat(vscode-extension): add orbitscore.scsynthPath setting and pass to engine |
| 4 | `7880462` | refactor(vscode-extension): unify selectAudioDevice through scsynth resolver |
| 5 | `9663a83` | feat(vscode-extension): add bundle status bar and first-run notification |
| 6 | `aca6450` | feat(build): add scsynth bundle extract/verify scripts and legal placeholders |
| 7 | `e25894d` | docs(worklog,readme): record scsynth bundle integration |
| 8 | `1569110` | refactor(audio): drop SC.app/spotlight fallback from scsynth resolver |
| 9 | `08c2855` | refactor(vscode-extension): align UX with strict bundle requirement |
| 10 | `5f93169` | docs(worklog,readme,build-guide): document strict resolver and dev workaround |
| 11 | `98277db` | docs(platform): scope v1.0 to macOS Apple Silicon only |
| 12 | `bb94fe6` | fix(review): address claude-review feedback (libsndfile LGPL, JSDoc, DRY, dead code) |
| 13 | `58d9825` | docs(extension-readme): restructure for marketplace + bump version to 1.1.0 |
| 14 | `df3e8f7` | refactor(vscode-extension): rename killSuperCollider command to forceKillScsynth |
| 15 | `fbd033a` | fix(vscode-extension): exec→execFile in selectAudioDevice + status bar settings target |
| 16 | `e82e0ef` | fix(vscode-extension): skip engine spawn when scsynth unresolvable (avoid double error notice) |
| 17 | `2f8f4d8` | refactor(vscode-extension): reuse pre-check resolution + execFile for all killall (review minors) |
| 18 | this | docs(legal): embed GPL-3.0 verbatim + NOTICE aggregation clause (closes #139) |

**新規ファイル**:
- `packages/engine/src/audio/supercollider/scsynth-resolver.ts` (resolver 本体、strict mode)
- `tests/audio/scsynth-resolver.spec.ts` (10 unit tests、CI 実行可)
- `scripts/extract-scsynth-bundle.sh` (SC.app 自動 discovery + 26 plugin filter + 検証)
- `scripts/verify-bundle.sh` (`.vsix` 解凍後の signature/permission 確認)
- `packages/vscode-extension/legal/scsynth-LICENSE.GPL-3.0` (#139 placeholder)
- `packages/vscode-extension/legal/scsynth-NOTICE` (GPL-3.0 §6 corresponding source URL 明記)

**Path resolver 仕様** (engine 側に唯一存在、extension は `require` で再利用):
1. `opts.explicit` (caller 明示)
2. `process.env.ORBIT_SCSYNTH_PATH` (extension が settings から渡す)
3. Bundle (`<engine root>/scsynth/Contents/Resources/scsynth`)

**Strict mode の理由** (本 PR レビュー過程で確定): 当初は SC.app fallback と Spotlight も持っていたが、ICMC リリース目標 (「SC が無くても動く」) に対して fallback はテストの意味を曖昧にすると判断。bundle 抽出失敗を SC.app が肩代わりして production の不具合を隠蔽するリスクを排除するため、Phase 8 で fallback を削除。bundle が無ければ即 `ScsynthNotFoundError` で fail loud。各候補で `fs.statSync` + 実行権限ビット (`mode & 0o111`) を検査。`daemon-client.ts:417-433` の `resolveDaemonBinary()` パターン流用。

**Dev workflow への影響**:
- engine 単独 CLI (`npm run dev:engine`) で SC.app に依存していた dev は `ORBIT_SCSYNTH_PATH=/Applications/SuperCollider.app/Contents/Resources/scsynth` を env で渡す
- vscode-extension 経由 (通常 user) は build pipeline で bundle 同梱、何もしなくて OK

**First-run UX** (CodeX 指摘「status bar degraded」反映 + Phase 9 で strict mode 整合):
- StatusBar item (priority 99) で source 別に icon: `bundle` (✅) / `env`/`explicit` (⚙️ custom) / 解決失敗 (❌ error 背景)
- `startEngine()` 実行時に解決失敗 → 毎回 `showErrorMessage` (Open Settings / View Logs)
- 当初設計の "Don't Show Again" dismiss 機構は廃止 (silent fallback がない以上、Notice を黙らせる選択肢自体が不適切)

**リリース戦略** (本 PR レビュー過程で確定):
- ICMC v1.0 初回は **GitHub Release に `.vsix` を添付**して配布、ユーザは ダウンロード + ダブルクリック (or `code --install-extension`) で install
- Marketplace 自動 publish (#137) は ICMC ブロッカーから降格可能 (別 issue で再整理)

**動作環境** (v1.0): **macOS (Apple Silicon)** のみ。bundle scsynth は universal binary だが、Intel Mac は未テスト。Windows / Linux は scsynth bundle に対応 binary が同梱されないため非対応 (cross-platform は将来 issue で扱う)。Marketplace publish 時は `vsce package --target darwin-arm64` で OS gate を明示する想定。

**実機検証 (SC 3.14.1 環境)**:
- `npm run build:bundle` → 11MB bundle 生成、26 plugins、universal arm64+x86_64
- `npm run verify:bundle` → 11/11 checks pass (signature valid、TeamIdentifier=HE5VJFE9E4)
- engine test 240 pass / 23 skipped (resolver 10 新規 + 既存 230 維持、Phase 8 で sc-app/spotlight test 1 件削減)
- TypeScript build clean、ESLint clean

**スコープ外** (本 PR で実装しない):
- #137 Marketplace 自動 publish workflow (リリース戦略変更で ICMC ブロッカーから降格、別 issue で再整理予定)
- #138 cold-install acceptance test (実機 SC-less Mac で別途検証)
- #151 OrbitScore: Check Audio Setup (post-icmc)
- #152 OrbitScore: Open Examples (post-icmc)
- #156 環境変数名統一 (post-icmc、Phase 15 review feedback)

**スコープに吸収** (本 PR で完了):
- #139 LICENSE/NOTICE 文言洗練 → Phase 18 で GPL-3.0 verbatim 同梱 + NOTICE に separate works (OSC IPC) aggregation 明記 + libsndfile LGPL-2.1 区別 (Phase 12)。本 PR マージで #139 close。

**後続**:
- 本 PR マージ → #138 で SC-less Mac の cold-install 検証
- #138 通過 → 手動 GitHub Release で `.vsix` 配布開始
- ICMC 2026 リリース ready

---

### 6.64 Issue #153: pre-edit-check.sh allow plan-mode plan files (May 02, 2026)

**Date**: May 02, 2026
**Status**: ✅ COMPLETE
**Branch**: `153-hook-allow-plans-dir`
**Issue**: #153

**Work Content**: Claude Code plan mode の plan file (`.claude/plans/<name>.md`) 書込が main ブランチで `pre-edit-check.sh` にブロックされ workflow が完結しない問題を解決。Issue #136 (scsynth bundle) の plan 作成中に発見した hook 改善作業。

**実装**:
- `.claude/hooks/pre-edit-check.sh` 修正
  - stdin から `tool_input.file_path` を読み取る処理を追加 (jq 優先、python3 fallback)
  - `case` 判定で `*/.claude/plans/*` パスは早期 `exit 0` で通過
- 既存の main 編集 deny ロジックと branch 命名警告は無改修

**検証**:
- Sanity test 7 ケースすべて pass
  - feature branch + 通常 file → exit 0 (既存通り)
  - feature branch + plan file → exit 0 (新挙動、early allow)
  - 空 stdin / malformed JSON / `tool_input.file_path` 欠落 → exit 0 (graceful)
  - simulated main + plan file → exit 0 (新挙動、early allow)
  - simulated main + 通常 file → deny JSON 出力 + exit 0 (既存通り)

**後続**:
- 本 fix で plan mode workflow が main ブランチでも完結可能に
- 将来 `claude-tools` リポジトリに汎用 branch-protection plugin を作る際の参考実装

---


---

## Archived sections

Older entries have been archived by month for readability:

- [2025-09](../archive/WORK_LOG_2025-09.md)
- [2025-10](../archive/WORK_LOG_2025-10.md)
- [2026-02](../archive/WORK_LOG_2026-02.md)
- [2026-04](../archive/WORK_LOG_2026-04.md)

