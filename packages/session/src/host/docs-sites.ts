/**
 * `--docs-dir`（複数可・先勝ち・計画 N-3）から user / dev の 2 系統の在りかを決める（設計 848 §5.3.5・
 * 別冊 `848-docs-structure-design.md` §6.2）。
 *
 * ディレクトリの形は 2 つを受ける:
 * - **モノレポのチェックアウト**（`<dir>/sites/user` がある）: 凍結版と同じ `resolveUserDocsLocation` /
 *   `resolveDevDocsLocation`（`mcp/mcp-docs.ts` は凍結版の写し）で、Markdown は `sites/<site>`、
 *   ビルド済みの dist は `sites/<site>/.vitepress/dist`
 * - **`.app` の同梱**（`<dir>/user` がある・別冊 §6.2）: Markdown は `<dir>/user`、dist は `<dir>/user-site`。
 *   dev サイトは同梱しない（owner 決定 2026-09-18）
 *
 * 先に挙げたディレクトリが、その系統を持っていれば勝つ。
 */
import fs from 'node:fs'
import path from 'node:path'

import { resolveDevDocsLocation, resolveUserDocsLocation } from '../mcp/mcp-docs'

export interface DocsSiteLocation {
  /** Markdown の置き場（`docs.get` / `docs.search` の対象）。 */
  sourceRoot: string
  /** ビルド済みの HTML（`/orbitscore/**` で配る）。 */
  distRoot: string
}

export interface DocsSites {
  user: DocsSiteLocation | null
  dev: DocsSiteLocation | null
}

export function resolveDocsSites(docsDirs: readonly string[]): DocsSites {
  const sites: DocsSites = { user: null, dev: null }
  for (const dir of docsDirs) {
    if (fs.existsSync(path.join(dir, 'sites', 'user'))) {
      const user = resolveUserDocsLocation(dir, dir)
      sites.user ??= { sourceRoot: user.sourceRoot, distRoot: user.root }
      const dev = resolveDevDocsLocation(dir)
      if (dev.available) sites.dev ??= { sourceRoot: dev.sourceRoot, distRoot: dev.root }
    } else if (fs.existsSync(path.join(dir, 'user'))) {
      sites.user ??= { sourceRoot: path.join(dir, 'user'), distRoot: path.join(dir, 'user-site') }
    }
  }
  return sites
}
