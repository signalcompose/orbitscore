/**
 * Session-log opt-in gate (§L1 / #229).
 *
 * The session log is dormant by default in 2.0.0 and activates only when
 * `ORBITSCORE_SESSION_LOG=1` is set. This tiny helper centralises the check
 * so both `play-mode.ts` and `repl-mode.ts` share the same logic, and so it
 * can be unit-tested without mutating `process.env` in the test suite.
 *
 * Only the string `'1'` opts in; every other value (including `'0'`, `'true'`,
 * unset) leaves the log disabled.
 */
export function shouldEnableSessionLog(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORBITSCORE_SESSION_LOG === '1'
}
