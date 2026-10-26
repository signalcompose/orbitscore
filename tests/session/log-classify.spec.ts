/**
 * `log.line` の分類と `get_log` の ring（設計 848 §5.3.6）。
 *
 * ring の中身は凍結版と同じ規則で同じ文字列にする（`get_log` の戻りは MCP の v1 関門）。層 2 は
 * 凍結版 `shouldFilterLine` を写しているので、同じ行に同じ答えを返すことを事例で確かめる（#964 の
 * `🎚️` の行を含む）。
 */
import { describe, expect, it } from 'vitest'

import {
  classifyEngineLine,
  classifySessionLine,
  shouldFilterLine,
} from '../../packages/session/src/host/log-classify'
import { LogHub, LOG_RING_MAX } from '../../packages/session/src/host/log-hub'
import { shouldFilterLine as frozenShouldFilterLine } from '../../packages/vscode-extension/src/engine-handlers'

/** 凍結版の分類の事例（engine の stdout に実際に出る形）。 */
const LINES = [
  '🎵 OrbitScore Audio Engine',
  '✅ Initialized',
  '🎵 Live coding mode',
  '✅ Global running',
  '✅ Global stopped',
  '✅ Global starting',
  '▶ kick (loop)',
  '⏹ kick',
  '🔄 hat',
  '🎚️ hat: play=[{"type":"nested","elements":[0,1]},1] (next cycle)',
  '🎚️ hat: play=[{"type":"tie"},1,0] (next cycle)',
  '🎛️ effect updated',
  '⚠️ something odd',
  '[ERROR] Variable not found: global',
  'ERROR: something',
  '[STEP] kick 0 1700000000000',
  '✓',
  '{"evalMark":{"requestId":"r","ok":true,"diagnostics":[]}}',
  '{"engineState":{"requestId":"r","ok":true}}',
  '🔊 Playing: kick.wav',
  '  "type": "x"',
  '}',
  '   ',
  '12: something',
  '-1.5,',
  'plain message from the engine',
  '[daemon] 2026-10-26T00:00:00.000000Z  INFO orbit_audio_daemon: listening on 127.0.0.1:1234',
  '[daemon] INFO [orbit-vst3-instrument-child] state restored',
  'Output Device: Built-in',
  'channels: 2',
]

describe('shouldFilterLine — the copy agrees with the frozen extension', () => {
  it.each(LINES)('%j', (line) => {
    expect(shouldFilterLine(line)).toBe(frozenShouldFilterLine(line))
  })
})

describe('classifyEngineLine (design 848 §5.3.6)', () => {
  it('stdout lines the frozen filter keeps are info (warn with ⚠️) and land in the normal ring', () => {
    expect(classifyEngineLine('stdout', '✅ Global running')).toMatchObject({
      level: 'info',
      kind: 'engine',
      ringText: { normal: '✅ Global running', debug: '✅ Global running' },
    })
    expect(classifyEngineLine('stdout', '⚠️ something odd').level).toBe('warn')
  })

  it('stdout lines the frozen filter drops are debug and stay out of the normal ring', () => {
    expect(classifyEngineLine('stdout', '🔊 Playing: kick.wav')).toMatchObject({
      level: 'debug',
      ringText: { normal: null, debug: '🔊 Playing: kick.wav' },
    })
  })

  it('#964: a play() update line with "type" in it is kept', () => {
    const line = '🎚️ hat: play=[{"type":"tie"},1,0] (next cycle)'
    expect(classifyEngineLine('stdout', line).ringText.normal).toBe(line)
  })

  it('stderr lines are errors and get the frozen "ERROR: " prefix in both rings', () => {
    expect(classifyEngineLine('stderr', 'boom')).toMatchObject({
      level: 'error',
      kind: 'engine',
      ringText: { normal: 'ERROR: boom', debug: 'ERROR: boom' },
    })
  })

  it('daemon tracing lines take their own level; unreadable daemon lines are errors (fail-loud)', () => {
    expect(
      classifyEngineLine(
        'stdout',
        '[daemon] 2026-10-26T00:00:00.000000Z  INFO orbit_audio_daemon: listening on 127.0.0.1:1',
      ),
    ).toMatchObject({ kind: 'daemon', level: 'info' })
    expect(
      classifyEngineLine('stdout', '[daemon] WARN [orbit-clap-host] no note port'),
    ).toMatchObject({ kind: 'daemon', level: 'warn' })
    expect(classifyEngineLine('stdout', '[daemon] DEBUG [orbit-clap-host] x').level).toBe('debug')
    expect(classifyEngineLine('stderr', '[daemon] thread panicked')).toMatchObject({
      kind: 'daemon',
      level: 'error',
      ringText: { normal: 'ERROR: [daemon] thread panicked' },
    })
  })
})

describe('classifySessionLine', () => {
  it('error lines of the intake keep the frozen stderr shape in the ring', () => {
    expect(classifySessionLine('diagnostic', 'error', '[ERROR] boom')).toMatchObject({
      kind: 'diagnostic',
      level: 'error',
      ringText: { normal: 'ERROR: [ERROR] boom' },
    })
  })
})

describe('LogHub — get_log', () => {
  const hub = (debug: boolean) => {
    const sent: unknown[] = []
    return {
      hub: new LogHub(
        (line) => sent.push(line),
        () => debug,
        () => 42,
      ),
      sent,
    }
  }

  it('non-debug ring drops filtered lines and [STEP]; debug ring keeps both (frozen raw stream)', () => {
    const normal = hub(false)
    const debug = hub(true)
    for (const target of [normal, debug]) {
      target.hub.emit(classifyEngineLine('stdout', '🔊 Playing: kick.wav'))
      target.hub.recordStep('[STEP] kick 0 1700000000000')
      target.hub.emit(classifyEngineLine('stdout', '✅ Global running'))
      target.hub.emit(classifyEngineLine('stderr', 'boom'))
    }
    expect(normal.hub.select()).toEqual(['✅ Global running', 'ERROR: boom'])
    expect(debug.hub.select()).toEqual([
      '🔊 Playing: kick.wav',
      '[STEP] kick 0 1700000000000',
      '✅ Global running',
      'ERROR: boom',
    ])
  })

  it('notifies every line with level, kind, ts and the attribution', () => {
    const { hub: logs, sent } = hub(false)
    logs.emit(classifyEngineLine('stdout', '🔊 Playing: kick.wav'), {
      evalId: 'e1',
      clientId: 'c1',
    })
    expect(sent).toEqual([
      {
        level: 'debug',
        kind: 'engine',
        text: '🔊 Playing: kick.wav',
        ts: 42,
        clientId: 'c1',
        evalId: 'e1',
      },
    ])
  })

  it('keeps the frozen window: default 50, capacity 1000, an explicit truncation notice', () => {
    const { hub: logs } = hub(false)
    for (let i = 0; i < LOG_RING_MAX + 5; i++)
      logs.emit(classifySessionLine('session', 'info', `l${i}`))
    expect(logs.select()).toHaveLength(50)
    expect(logs.select(2000)[0]).toBe(
      '[get_log] truncated: requested 2000 lines, ring buffer holds at most 1000; returning 1000.',
    )
    expect(logs.select(LOG_RING_MAX)[0]).toBe('l5')
  })
})
