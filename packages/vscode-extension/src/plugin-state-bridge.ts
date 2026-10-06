import { CorrelatedLineBridge } from './correlated-line-bridge'

export type PluginStateBridgeResult =
  | { requestId: string; ok: true; saved: unknown }
  | {
      requestId: string
      ok: false
      error: string
      code?: string
      details?: unknown
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

/** `//#savePluginState` の相関（骨格は `CorrelatedLineBridge`・#757）。 */
export class PluginStateBridge extends CorrelatedLineBridge<PluginStateBridgeResult> {
  constructor() {
    super({
      metaCommand: '//#savePluginState',
      label: 'plugin state',
      parse: parsePluginStateResultLine,
      failure: (requestId, error) => ({ requestId, ok: false, error }),
    })
  }

  send(
    writeLine: (line: string, onError: (error: Error) => void) => boolean | void,
    input: { requestId: string; sequence: string; index: number },
    timeoutMs = 10_000,
  ): Promise<PluginStateBridgeResult> {
    return this.request(
      writeLine,
      input.requestId,
      input,
      undefined,
      timeoutMs,
      'timed out waiting for engine response to //#savePluginState',
    )
  }
}
