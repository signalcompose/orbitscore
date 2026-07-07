/**
 * #390 live playhead — argPath tagging in the timing walk.
 *
 * Every timed event carries the dot-joined element indices of its origin in
 * the play() argument tree ("1.0" = first element inside the second arg).
 * Purely observational: the values feed the `[STEP]` stdout markers; timing
 * itself is asserted by the sibling specs in this directory.
 */

import { describe, expect, it } from 'vitest'

import { calculateEventTiming } from '../../packages/engine/src/timing/calculation'

describe('argPath tagging (#390)', () => {
  it('tags flat top-level elements with their index', () => {
    const events = calculateEventTiming([1, 0, 2, 1], 2000)
    expect(events.map((e) => e.argPath)).toEqual(['0', '1', '2', '3'])
  })

  it('tags nested group elements with dot-joined paths', () => {
    const events = calculateEventTiming([1, { type: 'nested', elements: [2, 3] }, 4], 3000)
    expect(events.map((e) => e.argPath)).toEqual(['0', '1.0', '1.1', '2'])
  })

  it('tags doubly nested elements', () => {
    const events = calculateEventTiming(
      [{ type: 'nested', elements: [1, { type: 'nested', elements: [2, 3] }] }],
      2000,
    )
    expect(events.map((e) => e.argPath)).toEqual(['0.0', '0.1.0', '0.1.1'])
  })

  it('tags rests (0) like any other slot — the playhead steps through silence', () => {
    const events = calculateEventTiming([1, { type: 'nested', elements: [0, 2] }], 2000)
    expect(events[1].sliceNumber).toBe(0)
    expect(events[1].argPath).toBe('1.0')
  })

  it('tags every stack voice with the stack slot path (one visual unit)', () => {
    const events = calculateEventTiming(
      [1, { type: 'stack', voices: [3, 5, { type: 'nested', elements: [7, 8] }] }],
      2000,
    )
    expect(events[0].argPath).toBe('0')
    // 3, 5 and the subdividing (7, 8) subtree all report the stack's own slot.
    const stackEvents = events.slice(1)
    expect(stackEvents.length).toBe(4)
    for (const event of stackEvents) {
      expect(event.argPath).toBe('1')
    }
  })

  it('tags legato group elements like nested groups', () => {
    const events = calculateEventTiming([{ type: 'legato', elements: [2, 4] }, 1], 2000)
    expect(events.map((e) => e.argPath)).toEqual(['0.0', '0.1', '1'])
  })

  it('tags event ties with their slot path', () => {
    const events = calculateEventTiming([1, { type: 'tie' }], 2000)
    expect(events[1].tie).toBe(true)
    expect(events[1].argPath).toBe('1')
  })
})
