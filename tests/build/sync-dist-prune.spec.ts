import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// `sync-dist.js` は CommonJS のビルドスクリプト。直接実行された時だけ走るようにガードして
// あるので、`require` しても副作用は無い（`require.main === module`）。
const require_ = createRequire(import.meta.url)
const { pruneOrphanedOutputs, sourceStemFor } = require_(
  '../../packages/engine/scripts/sync-dist.js',
) as {
  pruneOrphanedOutputs: (distDir: string, srcDir: string) => Promise<string[]>
  sourceStemFor: (fileName: string) => string | null
}

/**
 * 🔴 このロジックは **`.vsix` の中身を決める**。
 *
 * `tsc --build` の増分は、ソースを削除しても既に出力された `.js` / `.d.ts` とその map を
 * 消さない。`sync-dist.js` はコピー先から「対応するソースがもう無い出力」を落とすことで、
 * 削除済みモジュールが出荷物に載るのを防いでいる（#502 で SuperCollider を削除した時に
 * 必要になった）。判定を間違えても **npm test もビルドも緑のまま**で、壊れるのは出荷物だけ
 * なので、ここで数値と実ファイルの有無で固定する。
 */
describe('sync-dist の孤児出力 prune', () => {
  let root: string
  let src: string
  let dist: string

  const write = async (file: string, body = '') => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, body)
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orbsync-'))
    src = path.join(root, 'src')
    dist = path.join(root, 'dist')
    await mkdir(src, { recursive: true })
    await mkdir(dist, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('対応する .ts が無い出力を 4 種類すべて落とす', async () => {
    await write(path.join(src, 'kept.ts'))
    for (const suffix of ['.js', '.js.map', '.d.ts', '.d.ts.map']) {
      await write(path.join(dist, `kept${suffix}`))
      await write(path.join(dist, `retired${suffix}`))
    }

    const removed = await pruneOrphanedOutputs(dist, src)

    expect(removed).toHaveLength(4)
    expect(await readdir(dist)).toEqual(
      expect.arrayContaining(['kept.js', 'kept.js.map', 'kept.d.ts', 'kept.d.ts.map']),
    )
    expect(await readdir(dist)).not.toEqual(expect.arrayContaining(['retired.js']))
  })

  it('.tsx 由来の出力を残す（.ts だけを見ていると誤って消える）', async () => {
    await write(path.join(src, 'view.tsx'))
    await write(path.join(dist, 'view.js'))

    const removed = await pruneOrphanedOutputs(dist, src)

    expect(removed).toEqual([])
    expect(await readdir(dist)).toEqual(['view.js'])
  })

  it('.ts 由来でない成果物には触らない', async () => {
    // コピーされた JSON など。ソースが `src` に無くても消してはいけない。
    await write(path.join(dist, 'catalog.json'), '{}')
    await write(path.join(dist, 'notes.md'))

    const removed = await pruneOrphanedOutputs(dist, src)

    expect(removed).toEqual([])
    expect((await readdir(dist)).sort()).toEqual(['catalog.json', 'notes.md'])
  })

  it('中身が全部落ちたディレクトリ自体も畳み、戻り値に載せる', async () => {
    await write(path.join(dist, 'supercollider', 'osc-client.js'))
    await write(path.join(dist, 'supercollider', 'osc-client.d.ts'))

    const removed = await pruneOrphanedOutputs(dist, src)

    expect(removed).toHaveLength(3)
    expect(removed).toEqual(expect.arrayContaining([path.join(dist, 'supercollider')]))
    expect(await readdir(dist)).toEqual([])
  })

  it('入れ子が空になれば親まで畳む（post-order で処理されていること）', async () => {
    await write(path.join(dist, 'audio', 'supercollider', 'inner', 'types.js'))

    const removed = await pruneOrphanedOutputs(dist, src)

    // types.js + inner + supercollider + audio の 4 件。親は子の削除が終わってから空になる。
    expect(removed).toHaveLength(4)
    expect(await readdir(dist)).toEqual([])
  })

  it('生き残るファイルが 1 つでもあれば親ディレクトリは残す', async () => {
    await write(path.join(src, 'audio', 'kept.ts'))
    await write(path.join(dist, 'audio', 'kept.js'))
    await write(path.join(dist, 'audio', 'retired.js'))

    const removed = await pruneOrphanedOutputs(dist, src)

    expect(removed).toEqual([path.join(dist, 'audio', 'retired.js')])
    expect(await readdir(path.join(dist, 'audio'))).toEqual(['kept.js'])
  })

  it('sourceStemFor は 4 種類の接尾辞だけを剥がす', () => {
    expect(sourceStemFor('a.js')).toBe('a')
    expect(sourceStemFor('a.js.map')).toBe('a')
    expect(sourceStemFor('a.d.ts')).toBe('a')
    expect(sourceStemFor('a.d.ts.map')).toBe('a')
    expect(sourceStemFor('a.json')).toBeNull()
    expect(sourceStemFor('a.ts')).toBeNull()
  })
})
