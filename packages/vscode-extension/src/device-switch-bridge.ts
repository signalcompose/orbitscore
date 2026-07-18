/**
 * vscode-free FIFO/timeout/drain logic for the `//#selectAudioDevice` live bridge
 * (#484 D2.5, PR #501 review). Extracted out of `extension.ts` so the stateful
 * queue behavior — ordering, timeout cleanup, drain-on-exit — can be unit tested
 * without mocking `vscode` or spawning a real engine process (like `engine-view.ts`).
 *
 * `extension.ts` owns a single module-level `DeviceSwitchBridge` instance and wires
 * it to the real process: the stdout handler calls `handleLine()` for every raw
 * line, and the exit handler / `stopEngine()` call `drainAll()` so a resolver from
 * a dead engine can never FIFO-match a future engine's response.
 */

import { parseSelectAudioDeviceResultLine, type SelectAudioDeviceBridgeResult } from './engine-view'

interface PendingEntry {
  resolve: (result: SelectAudioDeviceBridgeResult) => void
  timer: ReturnType<typeof setTimeout>
}

export class DeviceSwitchBridge {
  private pending: PendingEntry[] = []

  /**
   * Send `//#selectAudioDevice <device>` via `writeLine` and wait for the
   * correlated JSON result line (delivered later through `handleLine`).
   *
   * `writeLine` is handed the meta line plus an `onError` callback the caller
   * should invoke from e.g. `stream.write(line, (err) => ...)` if the
   * underlying write fails asynchronously. Calling `onError` (or `writeLine`
   * itself throwing synchronously, or returning `false`) resolves this
   * specific pending entry with a synthetic `ok: false` rather than leaving it
   * pending until the timeout.
   */
  send(
    writeLine: (line: string, onError: (err: Error) => void) => boolean | void,
    device: string,
    timeoutMs = 10000,
  ): Promise<SelectAudioDeviceBridgeResult> {
    return new Promise((resolve) => {
      const entry: PendingEntry = {
        resolve,
        timer: setTimeout(() => {
          const idx = this.pending.indexOf(entry)
          if (idx >= 0) this.pending.splice(idx, 1)
          resolve({
            ok: false,
            error: 'timed out waiting for engine response to //#selectAudioDevice',
          })
        }, timeoutMs),
      }
      this.pending.push(entry)

      const onError = (err: Error): void => {
        this.failEntry(entry, err.message)
      }

      let writeOk: boolean | void
      try {
        writeOk = writeLine(`//#selectAudioDevice${device ? ' ' + device : ''}\n`, onError)
      } catch (err) {
        this.failEntry(entry, err instanceof Error ? err.message : String(err))
        return
      }
      if (writeOk === false) {
        this.failEntry(entry, 'failed to write //#selectAudioDevice to engine stdin')
      }
    })
  }

  private failEntry(entry: PendingEntry, error: string): void {
    const idx = this.pending.indexOf(entry)
    if (idx >= 0) this.pending.splice(idx, 1)
    clearTimeout(entry.timer)
    entry.resolve({ ok: false, error })
  }

  /**
   * Feed one raw stdout line. Returns `true` only if the line successfully
   * parsed as a `selectAudioDevice` bridge result (FIFO-matched against the
   * oldest pending request, if any is waiting). Returns `false` for every
   * other line, including one that *looks* like the bridge's shape
   * (`{"selectAudioDevice...`) but fails to parse — e.g. split across a chunk
   * boundary. Callers that separately detect the "looks like but didn't
   * parse" case (by checking the same prefix) can use a `false` return here
   * as the signal to log a warning.
   */
  handleLine(rawLine: string): boolean {
    const result = parseSelectAudioDeviceResultLine(rawLine)
    if (!result) return false
    const entry = this.pending.shift()
    if (entry) {
      clearTimeout(entry.timer)
      entry.resolve(result)
    }
    return true
  }

  /**
   * Resolve every still-pending request with a synthetic failure. Called when
   * the engine process exits or is stopped — a resolver from a dead engine
   * must never FIFO-match a future engine's response.
   */
  drainAll(error: string): void {
    const drained = this.pending
    this.pending = []
    for (const entry of drained) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, error })
    }
  }

  /** Number of requests currently awaiting a response — test/debug helper. */
  get pendingCount(): number {
    return this.pending.length
  }
}
