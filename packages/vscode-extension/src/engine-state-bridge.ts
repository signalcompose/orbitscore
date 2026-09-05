import { randomUUID } from 'crypto'

export type EngineStatusBridgeResult =
  | {
      requestId: string
      ok: true
      output: Record<string, unknown>
      callback: Record<string, unknown>
    }
  | { requestId: string; ok: false; error: string }

interface PendingEntry {
  resolve: (result: EngineStatusBridgeResult) => void
  timer: ReturnType<typeof setTimeout>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseEngineStatusResultLine(rawLine: string): EngineStatusBridgeResult | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawLine.trim())
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isRecord(parsed.engineState)) return undefined
  const result = parsed.engineState
  if (typeof result.requestId !== 'string' || typeof result.ok !== 'boolean') return undefined
  if (result.ok) {
    if (!isRecord(result.output) || !isRecord(result.callback)) return undefined
    return {
      requestId: result.requestId,
      ok: true,
      output: result.output,
      callback: result.callback,
    }
  }
  if (typeof result.error !== 'string') return undefined
  return { requestId: result.requestId, ok: false, error: result.error }
}

export class EngineStateBridge {
  private readonly pending = new Map<string, PendingEntry>()

  send(
    writeLine: (line: string, onError: (error: Error) => void) => boolean | void,
    timeoutMs = 10_000,
  ): Promise<EngineStatusBridgeResult> {
    const requestId = randomUUID()
    return new Promise((resolve) => {
      const entry: PendingEntry = {
        resolve,
        timer: setTimeout(() => {
          this.pending.delete(requestId)
          resolve({
            requestId,
            ok: false,
            error: 'timed out waiting for engine response to //#getEngineState',
          })
        }, timeoutMs),
      }
      this.pending.set(requestId, entry)
      const fail = (error: Error): void => this.fail(requestId, error.message)
      try {
        const written = writeLine(`//#getEngineState ${JSON.stringify({ requestId })}\n`, fail)
        if (written === false) {
          this.fail(requestId, 'failed to write //#getEngineState to engine stdin')
        }
      } catch (error) {
        this.fail(requestId, error instanceof Error ? error.message : String(error))
      }
    })
  }

  handleLine(rawLine: string): boolean {
    const result = parseEngineStatusResultLine(rawLine)
    if (!result) return false
    const entry = this.pending.get(result.requestId)
    if (entry) {
      this.pending.delete(result.requestId)
      clearTimeout(entry.timer)
      entry.resolve(result)
    }
    return true
  }

  drainAll(error: string): void {
    const pending = [...this.pending.entries()]
    this.pending.clear()
    for (const [requestId, entry] of pending) {
      clearTimeout(entry.timer)
      entry.resolve({ requestId, ok: false, error })
    }
  }

  private fail(requestId: string, error: string): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.resolve({ requestId, ok: false, error })
  }

  get pendingCount(): number {
    return this.pending.size
  }
}
