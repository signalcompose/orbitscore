import { randomUUID } from 'crypto'

import { CorrelatedLineBridge, type WriteLine } from './correlated-line-bridge'
import type { EngineState } from './mcp-server'

export type EngineStatusBridgeResult =
  | {
      requestId: string
      ok: true
      output: Record<string, unknown>
      callback: Record<string, unknown>
    }
  | { requestId: string; ok: false; error: string }

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

/** `//#getEngineState` の相関（骨格は `CorrelatedLineBridge`・#757）。requestId は自分で振る。 */
export class EngineStateBridge extends CorrelatedLineBridge<EngineStatusBridgeResult> {
  constructor() {
    super({
      metaCommand: '//#getEngineState',
      label: 'engine state',
      parse: parseEngineStatusResultLine,
      failure: (requestId, error) => ({ requestId, ok: false, error }),
    })
  }

  send(writeLine: WriteLine, timeoutMs = 10_000): Promise<EngineStatusBridgeResult> {
    const requestId = randomUUID()
    return this.request(writeLine, {
      requestId,
      payload: { requestId },
      context: undefined,
      timeoutMs,
      timeoutError: 'timed out waiting for engine response to //#getEngineState',
    })
  }
}

/**
 * `get_engine_state` の応答を組み立てる。
 *
 * 🔴 **daemon の状態が取れないことを理由に、このツールが例外で落ちてはいけない。** LLM は
 * これを「いま何が起きているか」を知る唯一の窓口として使うので、`running` だけでも返す方が
 * 何も返さないより役に立つ。取れなかった理由は `statusError` に載せる。
 *
 * 配線（`extension.ts` の `getEngineStateForAgent`）から切り離してあるのは、3 つの分岐
 * （停止中 / ブリッジが `ok:false` / ブリッジ自体が reject）を単体で固定するため。
 */
export async function resolveEngineState(
  base: Pick<EngineState, 'running' | 'liveCoding'>,
  fetchStatus: () => Promise<EngineStatusBridgeResult>,
): Promise<EngineState> {
  if (!base.running) return { ...base }
  try {
    const status = await fetchStatus()
    if (!status.ok) return { ...base, statusError: status.error }
    return { ...base, output: status.output, callback: status.callback }
  } catch (error) {
    return {
      ...base,
      statusError: error instanceof Error ? error.message : String(error),
    }
  }
}
