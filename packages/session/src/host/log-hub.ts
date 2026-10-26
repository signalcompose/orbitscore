/**
 * `log.line` の通知と、`get_log`（`session.getLog`）が返す ring（設計 848 §5.3.6）。
 *
 * ring の容量・既定の行数・切り詰めの通知は凍結版 `log-ring.ts` の `selectLogLines` と同じ
 * （`get_log` の戻りは MCP の v1 関門・台帳 P-03）。ring に積む文字列は `log-classify.ts` が決める。
 */
import type { ClassifiedLine } from './log-classify'

/** 凍結版 `OUTPUT_LOG_RING_MAX`。 */
export const LOG_RING_MAX = 1000
/** 凍結版 `DEFAULT_LOG_LINES`。 */
export const DEFAULT_LOG_LINES = 50

export interface LogLineNotification {
  level: ClassifiedLine['level']
  kind: ClassifiedLine['kind']
  text: string
  ts: number
  clientId?: string
  evalId?: string
}

export interface LogAttribution {
  clientId?: string
  evalId?: string
}

export class LogHub {
  private readonly ring: string[] = []

  constructor(
    private readonly notify: (line: LogLineNotification) => void,
    private readonly isDebug: () => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  emit(line: ClassifiedLine, attribution: LogAttribution = {}): void {
    const ringText = this.isDebug() ? line.ringText.debug : line.ringText.normal
    if (ringText !== null) this.push(ringText)
    this.notify({
      level: line.level,
      kind: line.kind,
      text: line.text,
      ts: this.now(),
      ...(attribution.clientId ? { clientId: attribution.clientId } : {}),
      ...(attribution.evalId ? { evalId: attribution.evalId } : {}),
    })
  }

  /** debug の時だけ `[STEP] …` の行を凍結版と同じ文字列で ring に積む（gated の playhead の題名が読む）。 */
  recordStep(raw: string): void {
    if (this.isDebug()) this.push(raw)
  }

  /** 凍結版 `selectLogLines` と同じ: 末尾 N 行。容量を超える要求には切り詰めの通知を 1 行付ける。 */
  select(requested?: number): string[] {
    const want = requested ?? DEFAULT_LOG_LINES
    const n = Math.max(1, Math.min(want, LOG_RING_MAX))
    const out = this.ring.slice(-n)
    if (want > LOG_RING_MAX) {
      return [
        `[get_log] truncated: requested ${want} lines, ring buffer holds at most ` +
          `${LOG_RING_MAX}; returning ${out.length}.`,
        ...out,
      ]
    }
    return out
  }

  private push(text: string): void {
    this.ring.push(text)
    if (this.ring.length > LOG_RING_MAX) this.ring.splice(0, this.ring.length - LOG_RING_MAX)
  }
}
