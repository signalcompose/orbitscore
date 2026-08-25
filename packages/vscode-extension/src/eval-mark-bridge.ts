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

export interface EvalDiagnostic {
  kind: 'parse' | 'runtime'
  message: string
}

export type EvalMarkResult =
  | { requestId: string; ok: true; diagnostics: EvalDiagnostic[] }
  | { requestId: string; ok: false; diagnostics: EvalDiagnostic[]; error?: string }

interface PendingEntry {
  resolve: (result: EvalMarkResult) => void
  timer: ReturnType<typeof setTimeout>
}

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

/** requestId 相関・timeout・engine 停止時の drain。 */
export class EvalMarkBridge {
  private readonly pending = new Map<string, PendingEntry>()

  send(
    writeLine: (line: string, onError: (error: Error) => void) => boolean | void,
    requestId: string,
    timeoutMs = 120_000,
  ): Promise<EvalMarkResult> {
    if (this.pending.has(requestId)) {
      return Promise.resolve({
        requestId,
        ok: false,
        diagnostics: [],
        error: `duplicate eval mark request id '${requestId}'`,
      })
    }
    return new Promise((resolve) => {
      const entry: PendingEntry = {
        resolve,
        timer: setTimeout(() => {
          this.pending.delete(requestId)
          resolve({
            requestId,
            ok: false,
            diagnostics: [],
            error:
              `timed out waiting for engine response to //#evalMark — the evaluation queue may ` +
              `be blocked (see the log for the blocking line)`,
          })
        }, timeoutMs),
      }
      this.pending.set(requestId, entry)
      const fail = (error: Error): void => this.fail(requestId, error.message)
      try {
        const written = writeLine(`//#evalMark ${JSON.stringify({ requestId })}\n`, fail)
        if (written === false) this.fail(requestId, 'failed to write //#evalMark to engine stdin')
      } catch (error) {
        this.fail(requestId, error instanceof Error ? error.message : String(error))
      }
    })
  }

  handleLine(line: string): boolean {
    const result = parseEvalMarkResultLine(line)
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
      entry.resolve({ requestId, ok: false, diagnostics: [], error })
    }
  }

  private fail(requestId: string, error: string): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.resolve({ requestId, ok: false, diagnostics: [], error })
  }
}
