/**
 * Process-tree classification for the gated harness teardown.
 *
 * ## Containment policy (applies to every function here and to their callers)
 *
 * 1. **Teardown always sweeps.** Best-effort cleanup must never be skipped because
 *    classification failed. Any path that cannot decide falls through to the force pass.
 * 2. **Absence is only claimed from a successful probe.** "No match" is absence; a probe that
 *    errored is *unknown*, and unknown is reported, never silently turned into "nothing here".
 * 3. **Unknown classification is safe by default.** A process whose parent cannot be determined
 *    is NOT treated as a root — signalling a helper directly is what makes VS Code show
 *    "The window terminated unexpectedly", which then waits for a human. It still gets swept.
 */

export interface ProcessRow {
  readonly pid: number
  /** `undefined` when the parent could not be determined (process gone, or the probe failed). */
  readonly ppid: number | undefined
}

/**
 * Roots are the processes to signal. A root is a harness-owned process whose parent is **not**
 * itself harness-owned — i.e. the app's main process, not one of its Electron helpers.
 *
 * Rows with an unknown parent are excluded (policy 3). They are still returned by the caller's
 * sweep, so nothing leaks.
 */
export function selectRootPids(rows: readonly ProcessRow[]): number[] {
  const owned = new Set(rows.map((row) => row.pid))
  return rows
    .filter((row) => row.ppid !== undefined && Number.isSafeInteger(row.ppid))
    .filter((row) => !owned.has(row.ppid as number))
    .map((row) => row.pid)
}

/** macOS caps a Unix domain socket path at this many characters (`sun_path[104]` in sys/un.h). */
export const UNIX_SOCKET_PATH_MAX = 103
/** Room for `<user-data-dir>/<version>-main.sock`; generous enough for a longer version string. */
export const IPC_SOCKET_SUFFIX_ALLOWANCE = 24

/**
 * VS Code's main process opens `<user-data-dir>/<version>-main.sock`. When that path exceeds the
 * macOS limit the process dies with `listen EINVAL` **before opening a window**, and the harness
 * sees only an MCP timeout — which reads as "the extension did not activate" and sends you
 * looking in the wrong place. Fail here instead, with the reason.
 */
export function userDataDirExceedsSocketLimit(userDataDir: string): boolean {
  return userDataDir.length + IPC_SOCKET_SUFFIX_ALLOWANCE > UNIX_SOCKET_PATH_MAX
}
