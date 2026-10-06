import { CorrelatedLineBridge, type WriteLine } from './correlated-line-bridge'

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

/** `//#pluginUi` の相関（骨格は `CorrelatedLineBridge`・#757）。待っている要求の action で突き合わせる。 */
export class PluginUiBridge extends CorrelatedLineBridge<PluginUiBridgeResult, PluginUiAction> {
  constructor() {
    super({
      metaCommand: '//#pluginUi',
      label: 'plugin UI',
      parse: parsePluginUiResultLine,
      failure: (requestId, error, action) => ({ requestId, action, ok: false, error }),
      accept: (result, action) =>
        result.action !== undefined && result.action !== action
          ? {
              requestId: result.requestId,
              action,
              ok: false,
              error: `engine returned plugin UI action '${result.action}' for pending '${action}' request`,
            }
          : result,
    })
  }

  send(
    writeLine: WriteLine,
    input: PluginUiBridgeInput,
    timeoutMs = 35_000,
  ): Promise<PluginUiBridgeResult> {
    return this.request(writeLine, {
      requestId: input.requestId,
      payload: input,
      context: input.action,
      timeoutMs,
      timeoutError: `timed out waiting for engine response to //#pluginUi ${input.action}`,
    })
  }
}
