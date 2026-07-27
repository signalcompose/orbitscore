import path from 'node:path'

import { defineConfig } from 'vitest/config'

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
})
