/**
 * 凍結版から層 2 へ写したモジュールの一覧（設計 848 §4.5.1・§10.3）。
 *
 * `frozen-copies.spec.ts` が写しの一致を検査し、`tests/repo/module-doc-purity.spec.ts` が
 * 「写しとその原本」の組だけを doc の重複の検査から外す（一致が強制されている組は、別のファイルの
 * doc を貼った欠陥ではない）。拡張版と共存する間だけの一覧で、退役で原本が消える時に消す。
 *
 * `rewrites` は置き場所の違いで変わる import のパスだけ（中身ではない）。
 */
// PROVISIONAL(P-09): 拡張版の退役で原本が消える時に、この一覧と両 spec の参照を消す。
export interface FrozenCopy {
  copy: string
  original: string
  rewrites?: ReadonlyArray<readonly [from: string, to: string]>
}

export const FROZEN_COPIES: readonly FrozenCopy[] = [
  {
    copy: 'packages/session/src/services/wav-analysis.ts',
    original: 'packages/vscode-extension/src/wav-analysis.ts',
  },
  {
    copy: 'packages/session/src/services/engine-view.ts',
    original: 'packages/vscode-extension/src/engine-view.ts',
  },
  {
    // `__dirname` から 3 つ上をモノレポのルートとして読むので、`src/` の直下に置いた。
    copy: 'packages/session/src/plugin-catalog-reader.ts',
    original: 'packages/vscode-extension/src/plugin-catalog-reader.ts',
  },
  {
    copy: 'packages/session/src/mcp/mcp-docs.ts',
    original: 'packages/vscode-extension/src/mcp-docs.ts',
  },
  {
    copy: 'packages/session/src/mcp/mcp-types.ts',
    original: 'packages/vscode-extension/src/mcp-types.ts',
    rewrites: [
      ["from './plugin-catalog-reader'", "from '../plugin-catalog-reader'"],
      ["from './wav-analysis'", "from '../services/wav-analysis'"],
    ],
  },
]
