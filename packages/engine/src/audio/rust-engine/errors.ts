/**
 * Rust daemon クライアントが投げるエラー分類。
 */

export class DaemonNotFoundError extends Error {
  constructor(searchedPaths: string[]) {
    super(
      `orbit-audio-daemon binary not found. Searched: ${searchedPaths.join(', ')}. ` +
        `Set ORBIT_AUDIO_DAEMON_PATH or build via \`cd rust && cargo build\`.`,
    )
    this.name = 'DaemonNotFoundError'
  }
}

/**
 * explicit (`daemonPath`) / env (`ORBIT_AUDIO_DAEMON_PATH`) override が「存在するが
 * 実行不可」の場合に投げる (Issue #383, `scsynth-resolver.ts` の `ScsynthNotExecutableError`
 * と対称)。monorepo release/debug 候補同士の fall-through は許容するが、ユーザー明示の
 * override だけは silent substitution を防ぐため後続候補へ fall-through せず fail loud する。
 */
export class DaemonNotExecutableError extends Error {
  readonly path: string
  readonly source: 'explicit' | 'env'

  constructor(path: string, source: 'explicit' | 'env') {
    const originDesc = source === 'env' ? 'env var ORBIT_AUDIO_DAEMON_PATH' : 'explicit daemonPath'
    super(
      `orbit-audio-daemon override via ${originDesc} points to a file that exists but is not ` +
        `executable: ${path}. Fix the permissions (chmod +x) or unset the override; it will not ` +
        `silently fall back to another daemon binary.`,
    )
    this.name = 'DaemonNotExecutableError'
    this.path = path
    this.source = source
  }
}

export class DaemonStartupError extends Error {
  readonly stderr: string
  readonly exitCode: number | null
  constructor(message: string, stderr: string, exitCode: number | null) {
    super(message)
    this.name = 'DaemonStartupError'
    this.stderr = stderr
    this.exitCode = exitCode
  }
}

export class DaemonQuitError extends Error {
  constructor(message = 'daemon client quit') {
    super(message)
    this.name = 'DaemonQuitError'
  }
}

/** WebSocket connection が予期せず close した場合に投げる。 */
export class DaemonConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonConnectionError'
  }
}

export class DaemonProtocolError extends Error {
  readonly code: string
  readonly details?: unknown
  constructor(code: string, message: string, details?: unknown) {
    super(`[${code}] ${message}`)
    this.name = 'DaemonProtocolError'
    this.code = code
    this.details = details
  }
}
