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
