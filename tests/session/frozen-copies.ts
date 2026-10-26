/**
 * 凍結版から層 2 へ写したモジュールの一覧（設計 848 §4.5.1・§10.3）。
 *
 * 写しと原本の差は、`tests/session/frozen-copies/<写しのファイル名>.patch` に置いたパッチ（hunk だけ）
 * と**完全に一致**しなければならない。パッチが無ければ差は 0（そのままの写し）。差を変える時は
 * `UPDATE_FROZEN_COPY_PATCHES=1 npx vitest run tests/session/frozen-copies.spec.ts` でパッチを書き直し、
 * パッチの差分をレビューで見せる（写しが凍結版からどう変わったかを、黙って変えない）。
 *
 * `tests/repo/module-doc-purity.spec.ts` は「写しと原本」の組だけを doc の重複の検査から外す
 * （差が固定されている組は、別のファイルの doc を貼った欠陥ではない）。
 */
// PROVISIONAL(P-09): 拡張版の退役で原本が消える時に、この一覧と両 spec の参照を消す。
export interface FrozenCopy {
  copy: string
  original: string
  /** パッチがある写しは、なぜ変えたか（設計の節）。 */
  why?: string
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
    copy: 'packages/session/src/mcp/mcp-sdk.ts',
    original: 'packages/vscode-extension/src/mcp-sdk.ts',
  },
  {
    copy: 'packages/session/src/mcp/mcp-tools-engine.ts',
    original: 'packages/vscode-extension/src/mcp-tools-engine.ts',
  },
  {
    copy: 'packages/session/src/mcp/mcp-tools-plugins.ts',
    original: 'packages/vscode-extension/src/mcp-tools-plugins.ts',
  },
  {
    copy: 'packages/session/src/mcp/mcp-types.ts',
    original: 'packages/vscode-extension/src/mcp-types.ts',
    why: '置き場所の違いによる import のパス 2 行と、凍結版で同期だった handler 5 本を Promise に広げた（設計 848 §6: 中継は RPC でこの型を満たす）',
  },
  {
    copy: 'packages/session/src/mcp/mcp-tools-editor.ts',
    original: 'packages/vscode-extension/src/mcp-tools-editor.ts',
    why: '同期だった handler 5 本を await する / docs 系 4 本は層 2 の docs.* を読む（設計 848 §5.3.5・§6）',
  },
  {
    copy: 'packages/session/src/mcp/evaluate-document-directory.ts',
    original: 'packages/vscode-extension/src/evaluate-document-directory.ts',
    why: '改行の制約を写さない（設計 848 §5.3.1・§6.1 の裁定による例外）。isOrbitscoreDocument は 1 行なので取り込んだ',
  },
]
