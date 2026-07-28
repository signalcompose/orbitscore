export type PluginStateBridgeResult =
  | { requestId: string; ok: true; saved: unknown }
  | {
      requestId: string
      ok: false
      error: string
      code?: string
      details?: unknown
    }

interface PendingEntry {
  resolve: (result: PluginStateBridgeResult) => void
  timer: ReturnType<typeof setTimeout>
}

export function parsePluginStateResultLine(line: string): PluginStateBridgeResult | undefined {
  if (!line.trim().startsWith('{"savePluginState"')) return undefined
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const envelope = (value as Record<string, unknown>).savePluginState
  if (typeof envelope !== 'object' || envelope === null) return undefined
  const result = envelope as Record<string, unknown>
  if (typeof result.requestId !== 'string' || typeof result.ok !== 'boolean') return undefined
  if (result.ok) {
    if (!('saved' in result)) return undefined
    return { requestId: result.requestId, ok: true, saved: result.saved }
  }
  if (typeof result.error !== 'string') return undefined
  return {
    requestId: result.requestId,
    ok: false,
    error: result.error,
    ...(typeof result.code === 'string' ? { code: result.code } : {}),
    ...(!('details' in result) ? {} : { details: result.details }),
  }
}

/** request ID相関・timeout・process終了drainを担うREPL bridge。 */
export class PluginStateBridge {
  private readonly pending = new Map<string, PendingEntry>()

  send(
    writeLine: (line: string, onError: (error: Error) => void) => boolean | void,
    input: { requestId: string; sequence: string; index: number },
    timeoutMs = 10_000,
  ): Promise<PluginStateBridgeResult> {
    if (this.pending.has(input.requestId)) {
      return Promise.resolve({
        requestId: input.requestId,
        ok: false,
        error: `duplicate plugin state request id '${input.requestId}'`,
      })
    }
    return new Promise((resolve) => {
      const entry: PendingEntry = {
        resolve,
        timer: setTimeout(() => {
          this.pending.delete(input.requestId)
          resolve({
            requestId: input.requestId,
            ok: false,
            error: 'timed out waiting for engine response to //#savePluginState',
          })
        }, timeoutMs),
      }
      this.pending.set(input.requestId, entry)
      const fail = (error: Error): void => {
        this.fail(input.requestId, error.message)
      }
      try {
        const written = writeLine(`//#savePluginState ${JSON.stringify(input)}\n`, fail)
        if (written === false) {
          this.fail(input.requestId, 'failed to write //#savePluginState to engine stdin')
        }
      } catch (error) {
        this.fail(input.requestId, error instanceof Error ? error.message : String(error))
      }
    })
  }

  handleLine(line: string): boolean {
    const result = parsePluginStateResultLine(line)
    if (!result) return false
    const entry = this.pending.get(result.requestId)
    if (!entry) return true
    this.pending.delete(result.requestId)
    clearTimeout(entry.timer)
    entry.resolve(result)
    return true
  }

  drainAll(error: string): void {
    const entries = [...this.pending.entries()]
    this.pending.clear()
    for (const [requestId, entry] of entries) {
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
