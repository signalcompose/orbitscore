import { randomBytes } from 'crypto'

const COUNTER_BITS = 21
const COUNTER_LIMIT = 2 ** COUNTER_BITS
const BOOT_NAMESPACE = randomBytes(4).readUInt32BE(0)
let nextCounter = 0

/**
 * Allocate an exact, JSON-safe integer window token.
 *
 * The random 32-bit namespace changes on every TS process start and the low 21 bits are a
 * monotone counter, so one process never reuses a token (up to the deliberately loud 2,097,152
 * window limit). Across TS restarts while one daemon survives, namespace collision probability is
 * 1 / 2^32 per pair of starts; the daemon's live binding check turns an actual collision into a
 * loud refusal rather than silent misattribution.
 */
export function allocatePluginUiWindowToken(): number {
  if (nextCounter >= COUNTER_LIMIT) {
    throw new Error('plugin UI window token counter exhausted for this engine process')
  }
  const token = BOOT_NAMESPACE * COUNTER_LIMIT + nextCounter
  nextCounter += 1
  if (!Number.isSafeInteger(token)) {
    throw new Error('plugin UI window token exceeded the JSON safe-integer range')
  }
  return token
}
