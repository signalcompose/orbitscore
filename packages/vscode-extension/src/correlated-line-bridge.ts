/**
 * requestId で相関する REPL メタコマンドの共通骨格（#757）。
 *
 * 拡張は `//#<command> {"requestId":…}` を engine の stdin へ書き、engine は stdout に
 * 1 行の JSON 封筒で答える。待つ側に要るのは、相関（requestId → 待っている Promise）・
 * timeout・書き込み失敗・engine 停止時の drain・同じ requestId の二重送信の拒否で、
 * これが eval mark / plugin UI / plugin state / engine state の 4 本にほぼ一字一句同じ形で
 * 複製されていた（既にずれていた: engine state だけ重複チェックが無かった）。
 *
 * 各ブリッジが注入するのは、メタコマンド名・結果行の parse・失敗結果の形・
 * （plugin UI だけ）待っている要求との突き合わせ、の 4 つだけ。
 *
 * `//#selectAudioDevice`（`DeviceSwitchBridge`）は requestId を持たず**送った順**で相関する
 * （FIFO）ので、この骨格には載せない。相関の仕組みが違うものを 1 つに畳むと、
 * 「どちらの規則で相関しているか」が型から読めなくなる。
 */

/** メタ行を engine の stdin へ書く関数。`false` / 同期 throw / `onError` のどれでも書き込み失敗。 */
export type WriteLine = (line: string, onError: (error: Error) => void) => boolean | void

export interface CorrelatedRequest<TContext> {
  requestId: string
  /** メタ行の JSON 本体。 */
  payload: unknown
  context: TContext
  timeoutMs: number
  timeoutError: string
}

export interface CorrelatedBridgeSpec<TResult extends { requestId: string }, TContext> {
  /** `//#evalMark` など。書き込み失敗の文言にも使う。 */
  readonly metaCommand: string
  /** 重複 requestId の文言に入る名前（`eval mark` / `plugin UI` など）。 */
  readonly label: string
  /** stdout の 1 行を結果として読む。このブリッジの封筒でなければ undefined。 */
  parse(line: string): TResult | undefined
  /** timeout・drain・書き込み失敗・重複で返す失敗結果。 */
  failure(requestId: string, error: string, context: TContext): TResult
  /** 待っていた要求と突き合わせて、返す結果を決める（既定はそのまま）。 */
  accept?(result: TResult, context: TContext): TResult
}

interface PendingEntry<TResult, TContext> {
  resolve: (result: TResult) => void
  timer: ReturnType<typeof setTimeout>
  context: TContext
}

/** requestId 相関・timeout・engine 停止時の drain。 */
export class CorrelatedLineBridge<TResult extends { requestId: string }, TContext = undefined> {
  private readonly pending = new Map<string, PendingEntry<TResult, TContext>>()

  constructor(private readonly spec: CorrelatedBridgeSpec<TResult, TContext>) {}

  /**
   * `writeLine` でメタ行を書き、相関した結果行（後で `handleLine` に届く）を待つ。
   * `writeLine` が `false` を返す・同期に throw する・`onError` を呼ぶ、のいずれでも
   * timeout を待たずにこの要求だけを失敗で解決する。
   */
  protected request(
    writeLine: WriteLine,
    { requestId, payload, context, timeoutMs, timeoutError }: CorrelatedRequest<TContext>,
  ): Promise<TResult> {
    if (this.pending.has(requestId)) {
      return Promise.resolve(
        this.spec.failure(
          requestId,
          `duplicate ${this.spec.label} request id '${requestId}'`,
          context,
        ),
      )
    }
    return new Promise((resolve) => {
      const entry: PendingEntry<TResult, TContext> = {
        resolve,
        context,
        timer: setTimeout(() => {
          this.pending.delete(requestId)
          resolve(this.spec.failure(requestId, timeoutError, context))
        }, timeoutMs),
      }
      this.pending.set(requestId, entry)
      const fail = (error: Error): void => this.fail(requestId, error.message)
      try {
        const written = writeLine(`${this.spec.metaCommand} ${JSON.stringify(payload)}\n`, fail)
        if (written === false) {
          this.fail(requestId, `failed to write ${this.spec.metaCommand} to engine stdin`)
        }
      } catch (error) {
        this.fail(requestId, error instanceof Error ? error.message : String(error))
      }
    })
  }

  /** stdout の 1 行を渡す。このブリッジの封筒として読めたら true（待ち手がいなくても）。 */
  handleLine(line: string): boolean {
    const result = this.spec.parse(line)
    if (!result) return false
    const entry = this.pending.get(result.requestId)
    if (!entry) return true
    this.pending.delete(result.requestId)
    clearTimeout(entry.timer)
    entry.resolve(this.spec.accept ? this.spec.accept(result, entry.context) : result)
    return true
  }

  /** 待っている要求をすべて失敗で解決する（engine の終了・停止時）。 */
  drainAll(error: string): void {
    const entries = [...this.pending.entries()]
    this.pending.clear()
    for (const [requestId, entry] of entries) {
      clearTimeout(entry.timer)
      entry.resolve(this.spec.failure(requestId, error, entry.context))
    }
  }

  get pendingCount(): number {
    return this.pending.size
  }

  private fail(requestId: string, error: string): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.resolve(this.spec.failure(requestId, error, entry.context))
  }
}
