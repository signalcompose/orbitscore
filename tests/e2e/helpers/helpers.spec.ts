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

import { analyzeWavBuffer } from '../../../packages/vscode-extension/src/wav-analysis'

import {
  captureClockSec,
  captureWindowsFrom,
  prepareCapturePath,
  quadraticMeanRms,
  readCaptureForAnalysis,
  readCaptureFormat,
  waitForSound,
} from './capture-windows'
import { countErrors, countLogMarker, LOG_WINDOW_LINES } from './engine-log'
import { logAnchor, logAppendedSince } from './run-score'
import { captureWavPath } from './gated-session'
import { runOrbitscoreCli } from './run-cli'
import { waitForFile, waitForMatchingFile } from './wait-for-file'

const tmpDirs: string[] = []
const makeTmpDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-helpers-spec-'))
  tmpDirs.push(dir)
  return dir
}

const syntheticFloat32Wav = (
  durationSec: number,
  opts: {
    sampleRate?: number
    channels?: number
    sample?: (timeSec: number, channel: number) => number
  } = {},
): Buffer => {
  const sampleRate = opts.sampleRate ?? 1000
  const channels = opts.channels ?? 2
  const frames = Math.round(durationSec * sampleRate)
  const dataBytes = frames * channels * 4
  const wav = Buffer.alloc(44 + dataBytes)
  wav.write('RIFF', 0, 'ascii')
  wav.writeUInt32LE(36 + dataBytes, 4)
  wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii')
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(3, 20)
  wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * channels * 4, 28)
  wav.writeUInt16LE(channels * 4, 32)
  wav.writeUInt16LE(32, 34)
  wav.write('data', 36, 'ascii')
  wav.writeUInt32LE(dataBytes, 40)
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      wav.writeFloatLE(
        opts.sample?.(frame / sampleRate, channel) ?? 0,
        44 + (frame * channels + channel) * 4,
      )
    }
  }
  return wav
}

const sineAfter =
  (startSec: number, phase = 0) =>
  (timeSec: number): number =>
    timeSec < startSec ? 0 : 0.25 * Math.sin(2 * Math.PI * 50 * (timeSec - startSec) + phase)

const expectCaptureInvariantFailure = (run: () => unknown, name: string): void => {
  expect(run).toThrow(name)
  for (const field of ['name', 'fromSec', 'toSec', 'durationSec', 'soundStartSec', 'bucketCount']) {
    expect(run, `${name} failure must report ${field}`).toThrow(field)
  }
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

describe('prepareCapturePath', () => {
  it('creates a missing capture directory so the daemon can open the file', () => {
    // 🔴 ディレクトリが無いと daemon の capture writer（`File::create`）が失敗し、
    // **エンジンの起動そのものが落ちる**。テスト側にはそれが
    // 「daemon-backed REPL ready after 30000ms」という無関係に見える形で現れる
    // （2026-09-05 に実機 gated 1 回分を失った）。
    const root = makeTmpDir()
    const capturePath = path.join(root, 'nested', 'deeper', 'take.wav')
    expect(fs.existsSync(path.dirname(capturePath))).toBe(false)

    prepareCapturePath(capturePath)

    expect(fs.existsSync(path.dirname(capturePath))).toBe(true)
    // ディレクトリを作るだけで、ファイルは作らない（daemon が作る）。
    expect(fs.existsSync(capturePath)).toBe(false)
  })

  it('removes a stale capture so a failed run cannot be measured as this one', () => {
    const root = makeTmpDir()
    const capturePath = path.join(root, 'take.wav')
    fs.writeFileSync(capturePath, 'stale bytes from a previous run')

    prepareCapturePath(capturePath)

    expect(fs.existsSync(capturePath)).toBe(false)
  })
})

describe('capture windows', () => {
  it('reads the fixed 44-byte float32 capture header', () => {
    const capturePath = path.join(makeTmpDir(), 'header.wav')
    fs.writeFileSync(capturePath, syntheticFloat32Wav(1, { sampleRate: 2000, channels: 2 }))

    expect(readCaptureFormat(capturePath)).toEqual({ sampleRate: 2000, channels: 2 })
  })

  it('maps capture file bytes to seconds', () => {
    const capturePath = path.join(makeTmpDir(), 'clock.wav')
    fs.writeFileSync(capturePath, syntheticFloat32Wav(1.25, { sampleRate: 2000, channels: 2 }))
    const format = readCaptureFormat(capturePath)

    expect(captureClockSec(capturePath, format)).toBe(1.25)
  })

  it('analyzes all capture bytes when the data header trails the writer', () => {
    const capturePath = path.join(makeTmpDir(), 'stale-header.wav')
    const wav = syntheticFloat32Wav(1.25, { sampleRate: 2000, channels: 2 })
    wav.writeUInt32LE(2000 * 2 * 4, 40)
    fs.writeFileSync(capturePath, wav)

    const staleHeaderCapture = fs.readFileSync(capturePath)
    expect(analyzeWavBuffer(staleHeaderCapture, { windowMs: 20 }).durationSec).toBe(1)

    const fullCapture = readCaptureForAnalysis(capturePath)
    expect(fullCapture.readUInt32LE(40)).toBe(0)
    expect(analyzeWavBuffer(fullCapture, { windowMs: 20 }).durationSec).toBe(1.25)
  })

  it('reports capture diagnostics when sound never starts', async () => {
    const capturePath = path.join(makeTmpDir(), 'silent.wav')
    fs.writeFileSync(capturePath, syntheticFloat32Wav(0.1))

    await expect(
      waitForSound(capturePath, {
        floor: 0.01,
        intervalMs: 1,
        timeoutMs: 2,
        label: 'silent synthetic capture',
      }),
    ).rejects.toThrow(/durationSec.*peak.*maxWindowRms.*stat\.size.*capturePath/)
  })

  it('detects continuous sound from absolute RMS windows even when there are no onsets', async () => {
    const capturePath = path.join(makeTmpDir(), 'continuous.wav')
    const wav = syntheticFloat32Wav(0.2, { sample: sineAfter(0) })
    fs.writeFileSync(capturePath, wav)
    expect(analyzeWavBuffer(wav, { windowMs: 20 }).onsets).toEqual([])

    await expect(
      waitForSound(capturePath, {
        floor: 0.01,
        intervalMs: 1,
        timeoutMs: 10,
        label: 'continuous synthetic capture',
      }),
    ).resolves.toBeUndefined()
  })

  it('selects the same buckets as the old range when its reverse-map offset is zero', () => {
    const analysis = analyzeWavBuffer(syntheticFloat32Wav(3, { sample: sineAfter(0) }), {
      windowMs: 20,
    })
    const segment = { fromSec: 0.5, toSec: 2.5, fromWall: 500, toWall: 2500 }
    const stopWall = analysis.durationSec * 1000
    const oldRange = {
      fromSec: analysis.durationSec - (stopWall - segment.fromWall) / 1000 + 0.15,
      toSec: analysis.durationSec - (stopWall - segment.toWall) / 1000 - 0.15,
    }
    const oldBuckets = analysis.windows!.filter(
      (window) => window.startSec >= oldRange.fromSec && window.startSec < oldRange.toSec,
    )

    expect(
      captureWindowsFrom(analysis, { steady: segment }, 'zero-offset').windows('steady'),
    ).toEqual(oldBuckets)
  })

  it('fails A1 when the first segment opens before sound', () => {
    const analysis = analyzeWavBuffer(syntheticFloat32Wav(2, { sample: sineAfter(0.5) }), {
      windowMs: 20,
    })
    expectCaptureInvariantFailure(
      () =>
        captureWindowsFrom(
          analysis,
          { early: { fromSec: 0.25, toSec: 1.75, fromWall: 250, toWall: 1750 } },
          'synthetic A1',
        ),
      'A1',
    )
  })

  it('fails U1 when the mapped width does not contain the expected bucket count', () => {
    const analysis = analyzeWavBuffer(syntheticFloat32Wav(2, { sample: sineAfter(0) }), {
      windowMs: 20,
    })
    analysis.windows = analysis.windows!.slice(0, 20)
    expectCaptureInvariantFailure(
      () =>
        captureWindowsFrom(
          analysis,
          { short: { fromSec: 0.25, toSec: 1.75, fromWall: 250, toWall: 1750 } },
          'synthetic U1',
        ),
      'U1',
    )
  })

  it('fails U2 when capture-clock duration disagrees with wall-clock duration', () => {
    const analysis = analyzeWavBuffer(syntheticFloat32Wav(2, { sample: sineAfter(0) }), {
      windowMs: 20,
    })
    expectCaptureInvariantFailure(
      () =>
        captureWindowsFrom(
          analysis,
          { stalled: { fromSec: 0.25, toSec: 1.75, fromWall: 250, toWall: 2250 } },
          'synthetic U2',
        ),
      'U2',
    )
  })

  it('fails U3 instead of clamping a segment outside capture time', () => {
    const analysis = analyzeWavBuffer(syntheticFloat32Wav(2, { sample: sineAfter(0) }), {
      windowMs: 20,
    })
    expectCaptureInvariantFailure(
      () =>
        captureWindowsFrom(
          analysis,
          { outside: { fromSec: 0.5, toSec: 2.1, fromWall: 500, toWall: 2100 } },
          'synthetic U3',
        ),
      'U3',
    )
  })

  it('requires an explicit boundary-probe marker for overlapping segments', () => {
    const analysis = analyzeWavBuffer(syntheticFloat32Wav(3, { sample: sineAfter(0) }), {
      windowMs: 20,
    })
    const first = { fromSec: 0.25, toSec: 1.25, fromWall: 250, toWall: 1250 }
    const overlapping = { fromSec: 1, toSec: 2, fromWall: 1000, toWall: 2000 }

    expectCaptureInvariantFailure(
      () => captureWindowsFrom(analysis, { first, overlapping }, 'synthetic U3 overlap'),
      'U3',
    )
    expect(() =>
      captureWindowsFrom(
        analysis,
        { first, boundaryProbe: { ...overlapping, overlapsPrevious: true } },
        'synthetic explicit overlap',
      ),
    ).not.toThrow()
  })

  it('keeps quadratic-mean RMS independent of sine phase', () => {
    const atPhase = (phase: number) =>
      analyzeWavBuffer(syntheticFloat32Wav(1, { sample: sineAfter(0, phase) }), { windowMs: 20 })
        .windows!

    expect(quadraticMeanRms(atPhase(0))).toBeCloseTo(quadraticMeanRms(atPhase(Math.PI / 3)), 8)
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

describe('run-score: engine restart detection in a bounded log window', () => {
  const MARKER = '🎵 Live coding mode'

  /**
   * 🔴 これが本命。**#611 PR-O0 の実機で実際に起きた壊れ方**を再現する。
   *
   * `get_log` は固定 500 行の窓なので、窓が飽和した状態で 1 行足すと **古い行が同時に落ちる**。
   * 「マーカーの件数が増えたか」で再起動を判定していた旧実装は、engine が実際に起動しても
   * 件数が増えず、`daemon-backed REPL ready after 30000ms` で必ずタイムアウトした。
   *
   * 錨方式はこの状況で**新しいマーカーを検出できる**。件数方式は検出できない。
   * 両方を同じ入力に当てて、**区別できる**ことを示す。
   */
  it('detects a fresh marker that the old count comparison misses when the window scrolls', () => {
    const window = 500
    // 飽和した窓: 先頭にマーカーが 1 つあり、残りは埋め草。
    const before = [MARKER, ...Array.from({ length: window - 1 }, (_, i) => `noise ${i}`)].join(
      '\n',
    )
    const anchor = logAnchor(before)

    // 再起動: マーカー 1 行を足し、窓の上限を守るため先頭を 1 行落とす（= 古いマーカーが消える）。
    const after = [...before.split('\n').slice(1), MARKER].join('\n')

    expect(
      countLogMarker(after, MARKER),
      '窓がスクロールしたので件数は増えていない — 旧実装が待ち続けた理由',
    ).toBe(countLogMarker(before, MARKER))

    expect(
      logAppendedSince(anchor, after).includes(MARKER),
      '錨より後ろに出た新しいマーカーを検出できること',
    ).toBe(true)
  })

  it('returns only the text appended after the anchor', () => {
    const before = 'line a\nline b\n'
    expect(logAppendedSince(logAnchor(before), `${before}line c\n`)).toBe('line c\n')
  })

  it('does not report a stale marker that sits before the anchor', () => {
    const before = `${MARKER}\nline a\n`
    // 起動しなかった: 錨より後ろには何も出ていない。
    expect(logAppendedSince(logAnchor(before), before)).toBe('')
    expect(logAppendedSince(logAnchor(before), before).includes(MARKER)).toBe(false)
  })

  /**
   * 🔴 錨が窓から流れたら **ログ全体が新しい出力**である。錨は前の窓の**末尾**から取り、
   * 窓は**先頭から**落ちるので、末尾が消えているならそれより古い行はすべて消えている。
   *
   * ⚠️ ここを「判定できない」として待つ実装にしたところ、`#628 R28` が
   * 「daemon-backed REPL ready after 30000ms」で落ちた（2026-09-04 実機）。
   * ラック child の起動で 500 行以上が流れ、錨が窓から出ただけだった。
   */
  it('treats the whole window as new when the anchor has scrolled out', () => {
    const before = 'old content that will be gone\n'
    const after = `${MARKER}\nentirely different content\n`
    expect(logAppendedSince(logAnchor(before), after)).toBe(after)
  })

  it('treats an empty anchor as "everything is new" (fresh session)', () => {
    expect(logAppendedSince(logAnchor(''), `${MARKER}\n`)).toBe(`${MARKER}\n`)
  })

  it('keeps the anchor short enough to survive a daemon restart inside the window', () => {
    // 起動で増えるのは十数行。錨がそれより長いと毎回流れてしまう。
    const anchor = logAnchor(
      Array.from({ length: LOG_WINDOW_LINES }, (_, i) => `line ${i}`).join('\n'),
    )
    expect(anchor.split('\n').length).toBeLessThan(60)
  })
})
