/**
 * `//#evalMark` の requestId 相関ブリッジ（#614）。
 *
 * 🔴 なぜ必要か
 *
 * `evaluate_orbitscore` の `ok` は「**stdin へ書けた**」しか意味していなかった。
 * パース/実行エラーは engine が stderr へ**非同期に**出すだけなので、呼び出し元は
 * `get_log` を別途読まない限り気づけない。
 *
 * このプロジェクトは **LLM を第一級ユーザー**として設計しているが、LLM には `ok` しか
 * 届かない（人間なら画面の赤い波線に気づく）。実際に「1260」制作中、パーサ未対応の
 * 記法を投入した LLM が `ok` を信じて先へ進み、**音が出ない原因を数時間探した**。
 *
 * 🔴 「どこまで待つか」を時間で決めない
 *
 * REPL は行を **FIFO** で処理する（#476）。コードの直後にマーカーを送れば、
 * **マーカーに到達した時点で先行コードの評価は完了している**。したがって settle 時間や
 * 「エラーが出ないこと」を待つ必要がない。長い評価（instrument 6 本の attach で 30 秒超）
 * でも、待つのは「実際に終わるまで」であって誤検知しない。
 *
 * timeout は最後の安全網としてのみ置く。詰まったキューは #608 の stall reporter が
 * 別途「塞いでいる行」を名指しして報告する。
 */

import { CorrelatedLineBridge } from './correlated-line-bridge'

export interface EvalDiagnostic {
  kind: 'parse' | 'runtime'
  message: string
}

export type EvalMarkResult =
  | { requestId: string; ok: true; diagnostics: EvalDiagnostic[] }
  | { requestId: string; ok: false; diagnostics: EvalDiagnostic[]; error?: string }

function toDiagnostics(value: unknown): EvalDiagnostic[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: EvalDiagnostic[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const d = entry as Record<string, unknown>
    if (d.kind !== 'parse' && d.kind !== 'runtime') return undefined
    if (typeof d.message !== 'string') return undefined
    out.push({ kind: d.kind, message: d.message })
  }
  return out
}

export function parseEvalMarkResultLine(line: string): EvalMarkResult | undefined {
  if (!line.trim().startsWith('{"evalMark"')) return undefined
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const envelope = (value as Record<string, unknown>).evalMark
  if (typeof envelope !== 'object' || envelope === null) return undefined
  const result = envelope as Record<string, unknown>
  if (typeof result.requestId !== 'string' || typeof result.ok !== 'boolean') return undefined
  const diagnostics = toDiagnostics(result.diagnostics)
  if (!diagnostics) return undefined
  return result.ok
    ? { requestId: result.requestId, ok: true, diagnostics }
    : { requestId: result.requestId, ok: false, diagnostics }
}

/** `//#evalMark` の相関（骨格は `CorrelatedLineBridge`・#757）。 */
export class EvalMarkBridge extends CorrelatedLineBridge<EvalMarkResult> {
  constructor() {
    super({
      metaCommand: '//#evalMark',
      label: 'eval mark',
      parse: parseEvalMarkResultLine,
      failure: (requestId, error) => ({ requestId, ok: false, diagnostics: [], error }),
    })
  }

  send(
    writeLine: (line: string, onError: (error: Error) => void) => boolean | void,
    requestId: string,
    timeoutMs = 120_000,
  ): Promise<EvalMarkResult> {
    return this.request(
      writeLine,
      requestId,
      { requestId },
      undefined,
      timeoutMs,
      `timed out waiting for engine response to //#evalMark — the evaluation queue may ` +
        `be blocked (see the log for the blocking line)`,
    )
  }
}
