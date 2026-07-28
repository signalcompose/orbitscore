import path from 'node:path'

import { configDefaults, defineConfig } from 'vitest/config'

// #527 review Critical #3: `vscode` only exists as a runtime module inside a
// real extension host (this repo only depends on `@types/vscode`), so
// `packages/vscode-extension/src/extension.ts` and `completion-context.ts`
// (the two source files that `import * as vscode from 'vscode'`) were never
// importable from a vitest spec. This alias lets
// `tests/vscode-extension/extension-wiring.spec.ts` import extension.ts's
// wiring functions directly against a minimal mock (tests/mocks/vscode.ts)
// instead of stopping at "untestable" the way the pre-existing effects-mock
// specs do — those only prove engine-lifecycle.ts's pure decision logic calls
// whatever fake it's handed, never that extension.ts wired the CORRECT real
// implementation into each same-shaped callback slot.
//
// This file is excluded from ESLint (see .eslintrc.cjs ignorePatterns —
// already anticipated there since the vitest scaffolding commit).
export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'tests/mocks/vscode.ts'),
    },
  },
  test: {
    // 🔴 `.claude/worktrees/` を discovery から外す。ここには subagent が作った
    // ブランチのフルコピーが残っており、**同じ spec ファイルが何本も存在する**。
    // vitest の位置引数は「発見済み全ファイルへの正規表現フィルタ」なので、
    // `vitest run tests/e2e/orbitstudio-mcp-gated.spec.ts` と書いても worktree 内の
    // 同名パスまで一致してしまう。
    //
    // 実害は理論上の話ではない: これで **実機 OrbitStudio が 7 個同時起動**し、
    // daemon が 19 本残留した（2026-07-28。同種の事故は WORK_LOG にも記録がある）。
    // gated spec 側のコメントは危険を警告しているだけで、何も強制していなかった。
    //
    // ⚠️ **既定値を手打ちで再現しない**。`test.exclude` に配列を渡すと vitest の
    // `defaultExclude` は**マージされず丸ごと置き換わる**（`@vitest/utils` の `deepMerge` が
    // 配列を mergeable から除外しているため）。当初 `node_modules` / `dist` だけを手で
    // 並べたところ、`**/.{idea,git,cache,output,temp}/**` や `**/cypress/**` の除外が
    // 黙って消えていた — **この PR が塞ごうとしている穴と同じ形の穴**を別の場所に
    // 開けていた（`.cache/` に spec を置くと実際に拾われることを実測で確認）。
    exclude: [...configDefaults.exclude, '**/.claude/worktrees/**'],
  },
})
