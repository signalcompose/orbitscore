import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  SessionLogWriter,
  EvalRecord,
} from '../../packages/engine/src/core/session-log/session-log-writer'

import { readOrbsLog } from './helpers'

/**
 * L1 (#229) — `.orbslog` session log writer. The writer is pure I/O + buffering:
 * the caller supplies the triple stamp, so these assert the file lifecycle —
 * preamble flush, naming, JSONL shape, stop record, re-start = new file — by
 * reading the written file back. Spec: SESSION_LOG_SPEC_v1 (§1/§3/§3.1).
 */

const META = { engineVersion: '1.1.0', dslVersion: '1.1' }

function ev(over: Partial<EvalRecord> = {}): EvalRecord {
  return {
    code: 'x',
    wall: 0,
    transport: null,
    effect: null,
    sourceFile: 'mypiece.orbs',
    evalSource: 'human',
    ...over,
  }
}

const readLog = readOrbsLog

describe('L1 — SessionLogWriter (§1/§3)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbslog-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const startArgs = (over: object = {}) => ({
    startedAtISO: '2026-06-14T21:30:05+09:00',
    stamp: '20260614-213005',
    wall: 3500,
    sourceFile: path.join(dir, 'mypiece.orbs'),
    ...over,
  })

  it('buffers pre-start evals and flushes them as the preamble (transport forced null)', () => {
    const w = new SessionLogWriter(META, dir)
    w.recordEval(ev({ code: 'var global = init GLOBAL', wall: 0 }))
    w.recordEval(ev({ code: 'kick.midi("IAC", 1)', wall: 1204 }))
    w.start(startArgs())

    const file = path.join(dir, 'mypiece.20260614-213005.orbslog')
    const recs = readLog(file)
    expect(recs[0]).toMatchObject({
      type: 'meta',
      logVersion: 1,
      startedAt: startArgs().startedAtISO,
    })
    expect(recs[1]).toMatchObject({
      type: 'eval',
      code: 'var global = init GLOBAL',
      wall: 0,
      transport: null,
    })
    expect(recs[2]).toMatchObject({
      type: 'eval',
      code: 'kick.midi("IAC", 1)',
      wall: 1204,
      transport: null,
    })
    expect(recs[3]).toMatchObject({ type: 'transport', event: 'start', wall: 3500 })
  })

  it('a preamble eval that carried a transport is still recorded with transport null', () => {
    const w = new SessionLogWriter(META, dir)
    w.recordEval(ev({ transport: '2:1.0', effect: '3:1.0' })) // shouldn't happen pre-start, but force null
    w.start(startArgs())
    const recs = readLog(path.join(dir, 'mypiece.20260614-213005.orbslog'))
    expect(recs[1]).toMatchObject({ type: 'eval', transport: null, effect: null })
  })

  it('appends post-start evals with the full triple stamp preserved', () => {
    const w = new SessionLogWriter(META, dir)
    w.start(startArgs())
    w.recordEval(
      ev({
        code: 'kick.play(1,0,3,5).root(2)',
        wall: 12040,
        transport: '2:3.482',
        effect: '3:1.0',
      }),
    )
    const recs = readLog(path.join(dir, 'mypiece.20260614-213005.orbslog'))
    const last = recs[recs.length - 1]
    expect(last).toMatchObject({
      type: 'eval',
      wall: 12040,
      transport: '2:3.482',
      effect: '3:1.0',
      code: 'kick.play(1,0,3,5).root(2)',
      evalSource: 'human',
    })
  })

  it('names the file <basename>.<stamp>.orbslog next to the .orbs', () => {
    const w = new SessionLogWriter(META, dir)
    w.start(startArgs())
    expect(w.getFilePath()).toBe(path.join(dir, 'mypiece.20260614-213005.orbslog'))
    expect(fs.existsSync(path.join(dir, 'mypiece.20260614-213005.orbslog'))).toBe(true)
  })

  it('falls back to untitled.<stamp>.orbslog in cwd when there is no source file', () => {
    const w = new SessionLogWriter(META, dir)
    w.start(startArgs({ sourceFile: null }))
    expect(w.getFilePath()).toBe(path.join(dir, 'untitled.20260614-213005.orbslog'))
    const recs = readLog(w.getFilePath()!)
    expect(recs[0]).toMatchObject({ type: 'meta', sourceFile: null })
  })

  it('writes a stop record with the supplied transport, then closes the session', () => {
    const w = new SessionLogWriter(META, dir)
    w.start(startArgs())
    w.stop(98000, '24:4.0')
    const recs = readLog(path.join(dir, 'mypiece.20260614-213005.orbslog'))
    expect(recs[recs.length - 1]).toMatchObject({
      type: 'transport',
      event: 'stop',
      wall: 98000,
      transport: '24:4.0',
    })
    expect(w.getFilePath()).toBeNull()
  })

  it('a second start() opens a NEW file; evals between stop and start become its preamble', () => {
    const w = new SessionLogWriter(META, dir)
    w.start(startArgs())
    w.stop(5000, '2:1.0')
    w.recordEval(ev({ code: 'after stop', wall: 6000 })) // buffered for the next session
    w.start(startArgs({ stamp: '20260614-220000' }))
    const file2 = path.join(dir, 'mypiece.20260614-220000.orbslog')
    const recs = readLog(file2)
    expect(recs[0].type).toBe('meta')
    expect(recs[1]).toMatchObject({ type: 'eval', code: 'after stop', transport: null })
    // first file still has its own stop record, untouched
    const recs1 = readLog(path.join(dir, 'mypiece.20260614-213005.orbslog'))
    expect(recs1[recs1.length - 1]).toMatchObject({ event: 'stop' })
  })

  it('recordEval before any start does not create a file (inert until start)', () => {
    const w = new SessionLogWriter(META, dir)
    w.recordEval(ev())
    expect(w.getFilePath()).toBeNull()
    expect(fs.readdirSync(dir)).toHaveLength(0)
  })

  it('every written line is valid standalone JSON (strict JSONL)', () => {
    const w = new SessionLogWriter(META, dir)
    w.recordEval(ev({ code: 'pre', wall: 0 }))
    w.start(startArgs())
    w.recordEval(ev({ code: 'post', wall: 100, transport: '1:1.0' }))
    w.stop(200, '1:2.0')
    const raw = fs.readFileSync(path.join(dir, 'mypiece.20260614-213005.orbslog'), 'utf8')
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(() => lines.forEach((l) => JSON.parse(l))).not.toThrow()
    expect(raw.endsWith('\n')).toBe(true) // line-terminated (append-only)
  })
})
