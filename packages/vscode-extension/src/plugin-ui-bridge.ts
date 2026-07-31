export type PluginUiAction = 'open' | 'close'

export type PluginUiBridgeResult =
  | { requestId: string; action: PluginUiAction; ok: true; result: unknown }
  | {
      requestId: string
      action?: PluginUiAction
      ok: false
      error: string
      code?: string
      details?: unknown
    }

export interface PluginUiBridgeInput {
  requestId: string
  action: PluginUiAction
  receiver: string
  index: number
  expectedName?: string
}

interface PendingEntry {
  action: PluginUiAction
  resolve: (result: PluginUiBridgeResult) => void
  timer: ReturnType<typeof setTimeout>
}

export function parsePluginUiResultLine(line: string): PluginUiBridgeResult | undefined {
  if (!line.trim().startsWith('{"pluginUi"')) return undefined
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const envelope = (value as Record<string, unknown>).pluginUi
  if (typeof envelope !== 'object' || envelope === null) return undefined
  const result = envelope as Record<string, unknown>
  if (typeof result.requestId !== 'string' || typeof result.ok !== 'boolean') return undefined
  const action = result.action
  if (action !== undefined && action !== 'open' && action !== 'close') return undefined
  if (result.ok) {
    if ((action !== 'open' && action !== 'close') || !('result' in result)) return undefined
    return { requestId: result.requestId, action, ok: true, result: result.result }
  }
  if (typeof result.error !== 'string') return undefined
  return {
    requestId: result.requestId,
    ...(action === undefined ? {} : { action }),
    ok: false,
    error: result.error,
    ...(typeof result.code === 'string' ? { code: result.code } : {}),
    ...(!('details' in result) ? {} : { details: result.details }),
  }
}

/** request ID correlation, timeout, and engine-process drain for plugin UI meta commands. */
export class PluginUiBridge {
  private readonly pending = new Map<string, PendingEntry>()

  send(
    writeLine: (line: string, onError: (error: Error) => void) => boolean | void,
    input: PluginUiBridgeInput,
    timeoutMs = 35_000,
  ): Promise<PluginUiBridgeResult> {
    if (this.pending.has(input.requestId)) {
      return Promise.resolve({
        requestId: input.requestId,
        action: input.action,
        ok: false,
        error: `duplicate plugin UI request id '${input.requestId}'`,
      })
    }
    return new Promise((resolve) => {
      const entry: PendingEntry = {
        action: input.action,
        resolve,
        timer: setTimeout(() => {
          this.pending.delete(input.requestId)
          resolve({
            requestId: input.requestId,
            action: input.action,
            ok: false,
            error: `timed out waiting for engine response to //#pluginUi ${input.action}`,
          })
        }, timeoutMs),
      }
      this.pending.set(input.requestId, entry)
      const fail = (error: Error): void => this.fail(input.requestId, error.message)
      try {
        const written = writeLine(`//#pluginUi ${JSON.stringify(input)}\n`, fail)
        if (written === false)
          this.fail(input.requestId, 'failed to write //#pluginUi to engine stdin')
      } catch (error) {
        this.fail(input.requestId, error instanceof Error ? error.message : String(error))
      }
    })
  }

  handleLine(line: string): boolean {
    const result = parsePluginUiResultLine(line)
    if (!result) return false
    const entry = this.pending.get(result.requestId)
    if (!entry) return true
    this.pending.delete(result.requestId)
    clearTimeout(entry.timer)
    if (result.action !== undefined && result.action !== entry.action) {
      entry.resolve({
        requestId: result.requestId,
        action: entry.action,
        ok: false,
        error: `engine returned plugin UI action '${result.action}' for pending '${entry.action}' request`,
      })
      return true
    }
    entry.resolve(result)
    return true
  }

  drainAll(error: string): void {
    const entries = [...this.pending.entries()]
    this.pending.clear()
    for (const [requestId, entry] of entries) {
      clearTimeout(entry.timer)
      entry.resolve({ requestId, action: entry.action, ok: false, error })
    }
  }

  private fail(requestId: string, error: string): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.resolve({ requestId, action: entry.action, ok: false, error })
  }

  get pendingCount(): number {
    return this.pending.size
  }
}
