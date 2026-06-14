import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { InterpreterV2 } from '../../packages/engine/src/interpreter/interpreter-v2'

import { readOrbsLog } from './helpers'

/**
 * L1 (#229) integration — the interpreter is the single eval-path interceptor.
 * With session logging enabled, driving real evals through `execute()` must
 * produce a `.orbslog` whose preamble, triple stamp, multi-file `sourceFile`,
 * and per-line durability match the spec. SuperCollider is mocked away.
 * Spec: SESSION_LOG_SPEC_v1 (§1/§3/§3.1).
 */

describe('L1 — session log via the interpreter (§1/§3)', () => {
  let interpreter: InterpreterV2
  let dir: string

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbslog-int-'))
    interpreter = new InterpreterV2()
    const audioEngine = interpreter.audioEngine as any
    audioEngine.boot = vi.fn().mockResolvedValue(undefined)
    audioEngine.getCurrentTime = vi.fn().mockReturnValue(0)
    audioEngine.scheduleEvent = vi.fn()
    audioEngine.scheduleSliceEvent = vi.fn()
    audioEngine.getMasterGainDb = vi.fn().mockReturnValue(0)
    interpreter.enableSessionLog({ engineVersion: '1.1.0', dslVersion: '1.1', cwd: dir })
    await interpreter.boot()
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const orbs = (name: string) => path.join(dir, name)
  async function run(src: string, sourceFile: string): Promise<void> {
    await interpreter.execute(parseAudioDSL(src), { source: src, sourceFile, evalSource: 'human' })
  }
  const logFiles = () => fs.readdirSync(dir).filter((f) => f.endsWith('.orbslog'))
  const readLog = (f: string) => readOrbsLog(path.join(dir, f))

  it('no .orbslog exists until global.start()', async () => {
    await run('var global = init GLOBAL', orbs('p.orbs'))
    await run('global.tempo(120)', orbs('p.orbs'))
    expect(logFiles()).toHaveLength(0) // buffered as preamble, not yet flushed
  })

  it('global.start() opens the file with meta + preamble (transport null) + start record', async () => {
    await run('var global = init GLOBAL', orbs('mypiece.orbs'))
    await run('global.tempo(120)\nglobal.beat(4 by 4)', orbs('mypiece.orbs'))
    await run('global.start()', orbs('mypiece.orbs'))

    const files = logFiles()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^mypiece\.\d{8}-\d{6}\.orbslog$/) // <basename>.<stamp>.orbslog
    const recs = readLog(files[0]!)
    expect(recs[0]).toMatchObject({ type: 'meta', logVersion: 1, sourceFile: orbs('mypiece.orbs') })
    // every preamble eval (incl. the start() call) carries transport: null
    const preamble = recs.filter((r) => r.type === 'eval')
    expect(preamble.length).toBeGreaterThanOrEqual(3)
    preamble.forEach((r) => expect(r.transport).toBeNull())
    expect(recs.some((r) => r.type === 'transport' && r.event === 'start')).toBe(true)
  })

  it('post-start evals carry a real bar:beat transport (triple stamp), stop carries its own', async () => {
    await run('var global = init GLOBAL', orbs('p.orbs'))
    await run('global.start()', orbs('p.orbs'))
    await run('global.tempo(132)', orbs('p.orbs'))
    await run('global.stop()', orbs('p.orbs'))

    const recs = readLog(logFiles()[0]!)
    const postStart = recs.find((r) => r.type === 'eval' && r.code === 'global.tempo(132)')
    expect(postStart).toBeDefined()
    expect(postStart.transport).toMatch(/^\d+:\d+\.\d+$/) // bar:beat, transport now running
    expect(postStart.wall).toBeGreaterThanOrEqual(0)
    const stop = recs[recs.length - 1]
    expect(stop).toMatchObject({ type: 'transport', event: 'stop' })
    expect(stop.transport).toMatch(/^\d+:\d+\.\d+$/) // captured before the clock cleared
  })

  it('records the originating sourceFile per eval (multi-file session)', async () => {
    await run('var global = init GLOBAL', orbs('main.orbs'))
    await run('global.start()', orbs('main.orbs'))
    await run('global.tempo(140)', orbs('voices.orbs')) // a second file drives the same engine

    const recs = readLog(logFiles()[0]!)
    expect(logFiles()[0]).toMatch(/^main\./) // naming follows the start() file
    const fromVoices = recs.find((r) => r.type === 'eval' && r.code === 'global.tempo(140)')
    expect(fromVoices.sourceFile).toBe(orbs('voices.orbs'))
    const fromMain = recs.find((r) => r.type === 'eval' && r.code === 'var global = init GLOBAL')
    expect(fromMain.sourceFile).toBe(orbs('main.orbs'))
  })

  it('is append-only with per-line flush: the file is fully parseable mid-session (kill-9 safe)', async () => {
    await run('var global = init GLOBAL', orbs('p.orbs'))
    await run('global.start()', orbs('p.orbs'))
    await run('global.tempo(132)', orbs('p.orbs'))
    // simulate inspecting the file WITHOUT a stop record (process killed mid-session):
    const raw = fs.readFileSync(path.join(dir, logFiles()[0]!), 'utf8')
    expect(raw.endsWith('\n')).toBe(true) // last completed line is terminated
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(() => lines.forEach((l) => JSON.parse(l))).not.toThrow()
    expect(lines.some((l) => l.includes('"event":"stop"'))).toBe(false) // no stop = valid truncated session
  })

  it('a LOOP launch stamps a non-null effect (resolved quantize boundary)', async () => {
    await run('var global = init GLOBAL', orbs('p.orbs'))
    await run('var kick = init global.seq', orbs('p.orbs'))
    await run('global.start()', orbs('p.orbs'))
    await run('LOOP(kick)', orbs('p.orbs')) // quantized → effect = next boundary

    const recs = readLog(logFiles()[0]!)
    const loopRec = recs.find((r) => r.type === 'eval' && r.code === 'LOOP(kick)')
    expect(loopRec).toBeDefined()
    expect(loopRec.effect).toMatch(/^\d+:\d+\.\d+$/) // a resolved bar:beat, not null
  })

  it('a non-LOOP eval leaves effect null (v1 §3.1: LOOP launches only)', async () => {
    await run('var global = init GLOBAL', orbs('p.orbs'))
    await run('global.start()', orbs('p.orbs'))
    await run('global.tempo(132)', orbs('p.orbs'))
    const recs = readLog(logFiles()[0]!)
    expect(recs.find((r) => r.code === 'global.tempo(132)').effect).toBeNull()
  })

  it('a second global.start() after stop opens a fresh file', async () => {
    await run('var global = init GLOBAL', orbs('p.orbs'))
    await run('global.start()', orbs('p.orbs'))
    await run('global.stop()', orbs('p.orbs'))
    await run('global.start()', orbs('p.orbs'))
    expect(logFiles()).toHaveLength(2) // two distinct sessions
  })
})
