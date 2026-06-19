/**
 * TA3 — shouldEnableSessionLog helper
 *
 * Verifies the opt-in gate logic for the session log (§L1 / #229):
 *   - unset  → false
 *   - '1'    → true
 *   - '0'    → false
 *   - 'true' → false
 *   - any other string → false
 *
 * The helper accepts an explicit `env` map so tests do NOT mutate process.env.
 */

import { describe, expect, it } from 'vitest'

import { shouldEnableSessionLog } from '../../packages/engine/src/cli/session-log-gate'

describe('shouldEnableSessionLog', () => {
  it('returns false when ORBITSCORE_SESSION_LOG is unset', () => {
    expect(shouldEnableSessionLog({})).toBe(false)
  })

  it("returns true only when ORBITSCORE_SESSION_LOG === '1'", () => {
    expect(shouldEnableSessionLog({ ORBITSCORE_SESSION_LOG: '1' })).toBe(true)
  })

  it("returns false for '0'", () => {
    expect(shouldEnableSessionLog({ ORBITSCORE_SESSION_LOG: '0' })).toBe(false)
  })

  it("returns false for 'true'", () => {
    expect(shouldEnableSessionLog({ ORBITSCORE_SESSION_LOG: 'true' })).toBe(false)
  })

  it('returns false for any other non-1 string', () => {
    expect(shouldEnableSessionLog({ ORBITSCORE_SESSION_LOG: 'yes' })).toBe(false)
    expect(shouldEnableSessionLog({ ORBITSCORE_SESSION_LOG: '' })).toBe(false)
    expect(shouldEnableSessionLog({ ORBITSCORE_SESSION_LOG: 'on' })).toBe(false)
  })
})
