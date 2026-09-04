/**
 * `tests/e2e/helpers/` 自身の検査（#668・束の締めのレビューで追加）。
 *
 * 🔴 **消費者のいない層は、テストでも型チェックでも守られない。**
 *
 * この束はその壊れ方を **2 回**踏んだ:
 *
 * 1. `gatedItTitles()` が `it.skipIf(cond)('title')` のカリー形を**1 件も拾えなかった**。
 *    消費者がいなかったので、**空振りで緑**のまま気づけなかった
 * 2. `/simplify` の整理で `waitForEngineState` から **`async` が剥がれた**。
 *    `npm test` は緑（`run-score.ts` をどの spec も import していない）、
 *    既定の `tsc -p tsconfig.json` も 0（**`tests/` を見ない**）。
 *    正本のゲート **`npm run typecheck:e2e`** だけが赤くなった
 *
 * したがって helper には**消費者が現れる前に**直接テストを付ける。対象は
 * **① コメントに書かれた受け入れ条件**と **② 壊れても黙って通る箇所**に絞る
 * （網羅ではなく、静かに壊れる場所を押さえるのが目的）。
 */
import { execFileSync, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import { countErrors, countLogMarker, LOG_WINDOW_LINES } from './engine-log'
import { captureWavPath } from './gated-session'
import { runOrbitscoreCli } from './run-cli'
import { waitForFile, waitForMatchingFile } from './wait-for-file'

const tmpDirs: string[] = []
const makeTmpDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-helpers-spec-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
  }
  delete process.env.ORBIT_KEEP_CAPTURES
})

describe('captureWavPath', () => {
  it('resolves to tmpRoot when ORBIT_KEEP_CAPTURES is unset', () => {
    // 🔴 この関数のコメントが明示する受け入れ条件そのもの（#668 PR-E2）。
    // 未設定時のパスが変わると、既存 20 本の capture 先が黙って動く。
    delete process.env.ORBIT_KEEP_CAPTURES
    expect(captureWavPath('/tmp/example-root', '643-instrument-basic')).toBe(
      path.join('/tmp/example-root', '643-instrument-basic.wav'),
    )
  })

  it('redirects to ORBIT_KEEP_CAPTURES so the evidence survives a failure', () => {
    // tmpRoot は afterAll で消えるので、落ちた時に証拠の WAV も一緒に消える。
    // これを設定した時だけ掃除対象から外れる（2026-08-29 の gain 欠陥はこの WAV で見つかった）。
    process.env.ORBIT_KEEP_CAPTURES = '/tmp/keep'
    expect(captureWavPath('/tmp/example-root', 'shifted')).toBe(
      path.join('/tmp/keep', 'shifted.wav'),
    )
  })
})

describe('engine-log', () => {
  it('counts a plain string marker', () => {
    expect(countLogMarker('a X b X c', 'X')).toBe(2)
  })

  it('counts a regex marker whether or not the caller passed the g flag', () => {
    // 🔴 `g` を付け忘れた正規表現は `match` が 1 件しか返さない。
    // ここで吸収していないと、呼び出し側が**黙って過少カウント**する。
    expect(countLogMarker('E: a\nE: b\nE: c', /E: /)).toBe(3)
    expect(countLogMarker('E: a\nE: b\nE: c', /E: /g)).toBe(3)
  })

  it('returns 0 for an empty string marker instead of looping forever', () => {
    expect(countLogMarker('anything', '')).toBe(0)
  })

  it('counts ERROR lines the way the gated suite does', () => {
    expect(countErrors('x\nERROR: one\ny\nERROR: two\n')).toBe(2)
    expect(countErrors('no failures here')).toBe(0)
  })

  it('states the fixed log window so callers compare with <=, not equality', () => {
    // #625: `get_log` は固定窓なので、件数の厳密等価は窓の外へ流れた瞬間に嘘になる。
    expect(LOG_WINDOW_LINES).toBe(500)
  })
})

describe('wait-for-file', () => {
  it('resolves once the file exists', async () => {
    const dir = makeTmpDir()
    const target = path.join(dir, 'late.txt')
    setTimeout(() => fs.writeFileSync(target, 'done'), 30)
    await expect(waitForFile(target, { timeoutMs: 3000, intervalMs: 10 })).resolves.toBeUndefined()
  })

  it('does not settle for a file that is still being written (minBytes)', async () => {
    // 🔴 `.orbslog` も stem WAV も**作成と書き込みが別**なので、存在だけを見ると 0 バイトを掴む。
    const dir = makeTmpDir()
    const target = path.join(dir, 'growing.bin')
    fs.writeFileSync(target, '')
    await expect(
      waitForFile(target, { timeoutMs: 120, intervalMs: 10, minBytes: 8 }),
    ).rejects.toThrow()
  })

  it('rejects rather than resolving silently when the file never appears', async () => {
    const dir = makeTmpDir()
    await expect(
      waitForFile(path.join(dir, 'never.txt'), { timeoutMs: 100, intervalMs: 10 }),
    ).rejects.toThrow()
  })

  it('matches a generated name whose stamp is not known in advance', async () => {
    const dir = makeTmpDir()
    fs.writeFileSync(path.join(dir, 'mypiece.20260612-2130.orbslog'), 'x')
    await expect(
      waitForMatchingFile(dir, /\.orbslog$/, { timeoutMs: 1000, intervalMs: 10 }),
    ).resolves.toContain('.orbslog')
  })

  it('accepts a reused g-flagged pattern on the second call too', async () => {
    // ⚠️ **このテストは `lastIndex` のリセットを証明しない**（2026-09-04 に変異で確認 —
    // リセットを外しても緑のままだった）。`test()` は `lastIndex` が末尾を超えると false を
    // 返すと同時に 0 へ戻すので、**次のポーリングで見つかる**。ループが吸収してしまう。
    //
    // 押さえているのは「**`g` 付きの正規表現を渡しても使える**」という契約だけ。
    // 主張をテストの実力に合わせておく（何を証明していないかを書いておかないと、
    // 次に読む人が守られていると誤解する）。
    const dir = makeTmpDir()
    fs.writeFileSync(path.join(dir, 'a.orbslog'), 'x')
    const shared = /\.orbslog$/g

    await expect(
      waitForMatchingFile(dir, shared, { timeoutMs: 1000, intervalMs: 10 }),
    ).resolves.toContain('.orbslog')
    await expect(
      waitForMatchingFile(dir, shared, { timeoutMs: 1000, intervalMs: 10 }),
    ).resolves.toContain('.orbslog')
  })
})

describe('run-cli', () => {
  it('proves the premise of using spawnSync: execFileSync loses stderr on success', () => {
    // 🔴 **この検査は helper ではなく、helper がそう書かれている理由を固定する。**
    //
    // `execFileSync` は**成功時に stdout の文字列しか返さない**ので、子プロセスが stderr へ
    // 書いても呼び出し元からは**原理的に見えない**。旧実装の `stderr: ''` は「何も出なかった」
    // ではなく「**出ても見えない**」を意味していた。exit 0 のまま警告だけ stderr に出す CLI の
    // 検証が書けなくなる。
    //
    // helper 自体でこれを検査できないのは、`runOrbitscoreCli` が CLI の entry を固定していて
    // 「stderr に書いて 0 で終わる」子プロセスを流し込めないため。**前提の方を実行で固定する。**
    const script = "process.stderr.write('warned'); process.exit(0)"

    const viaExecFile = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(viaExecFile).toBe('') // stdout だけ。stderr の 'warned' はどこにも現れない

    const viaSpawn = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(viaSpawn.status).toBe(0)
    expect(viaSpawn.stderr).toBe('warned') // 🔴 こちらは成功時でも届く
  })

  it('reports the signal separately from a non-zero exit', () => {
    // タイムアウトで殺された（`signal`）のと CLI が非ゼロで終わった（`status`）のは**別の失敗**。
    // 区別できないと、原因調査が空回りする。
    //
    // ⚠️ **このテストは「正常終了で signal が null」までしか見ていない。** 実際に殺した時に
    // signal が入ることは、`runOrbitscoreCli` の entry を差し替えられないのでここでは示せない
    // （上の前提テストと同じ理由）。主張をテストの実力に合わせておく。
    const result = runOrbitscoreCli(['--definitely-not-a-real-flag'], { timeoutMs: 5000 })
    expect(result.signal).toBeNull()
    expect(typeof result.status).toBe('number')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })
})
