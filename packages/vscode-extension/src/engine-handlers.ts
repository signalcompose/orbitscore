/**
 * VS Code-facing engine event handlers.
 *
 * Function bodies are moved unchanged from extension.ts. Helpers that were
 * module-private are exported only so the extension root and sibling engine
 * modules can preserve their existing wiring across module boundaries.
 */
import * as child_process from 'child_process'
import { StringDecoder } from 'node:string_decoder'

import {
  applyEngineError,
  applyEngineExit,
  applyEngineStdinError,
  applyEngineStdoutChunk,
  transportStatusText,
  type EngineExitEffects,
} from './engine-lifecycle'
import {
  engineProcess,
  engineStateBridge,
  engineViewProvider,
  evalMarkBridge,
  outputChannel,
  pluginStateBridge,
  pluginUiBridge,
  selectAudioDeviceBridge,
  setEngineProcess,
  setGlobalInitialized,
  setLiveCodingMode,
  setTransportPlaying,
  statusBarItem,
} from './extension-state'
import {
  clearAllPlayheadDecorations,
  clearPlayheadForSequence,
  handleStepLine,
} from './playhead-decorations'

/**
 * Filter stdout output in non-debug mode.
 */
export function shouldFilterLine(line: string): boolean {
  const trimmed = line.trim()

  // Machine-readable playhead markers (#390): parsed by setupStdoutHandler
  // from the raw stream BEFORE this filter runs; pure noise for humans
  // (~pattern-length lines per bar per seq), so keep them out of the channel.
  if (line.includes('[STEP]')) {
    return true
  }

  // Correlated REPL bridge envelopes are consumed above before human-log
  // transcription. Keep successful/error payloads (which may contain project
  // paths) out of the output channel; malformed envelopes get their own loud warning.
  //
  // 🔴 `{"evalMark"` を落とすのは見た目の問題ではない: envelope は失敗診断の本文
  // （例: `[OUTPROC_ATTACH_FAILED] ...`）を丸ごと含むので、transcribe されると
  // 同じ失敗が log に**二重に**現れ、get_log を数える側（E2E・LLM の自己検証）の
  // 前後比較が全部ずれる（#614 の導入時にこの除外が漏れていた実害）。
  if (
    trimmed.startsWith('{"savePluginState"') ||
    trimmed.startsWith('{"pluginUi"') ||
    trimmed.startsWith('{"evalMark"') ||
    trimmed.startsWith('{"engineState"')
  ) {
    return true
  }

  // Keep important messages
  if (line.includes('ERROR') || line.includes('⚠️') || line.includes('🎛️')) {
    return false
  }

  // Keep initialization messages
  if (
    line.includes('🎵 OrbitScore') ||
    line.includes('✅ Initialized') ||
    line.includes('✅ Mastering effect') ||
    line.includes('🎵 Live coding mode')
  ) {
    return false
  }

  // Keep transport state changes
  if (
    line.includes('✅ Global running') ||
    line.includes('✅ Global stopped') ||
    line.includes('✅ Global starting')
  ) {
    return false
  }

  // Keep user execution feedback
  if (line.includes('▶ ') || line.includes('⏹ ') || line.includes('🔄 ')) {
    return false
  }

  // Filter out verbose logs
  if (
    line.includes('🔊 Playing:') ||
    line.includes('sendosc:') ||
    line.includes('rcvosc :') ||
    line.includes('stdout :') ||
    line.includes('"oscType"') ||
    line.includes('"address"') ||
    line.includes('"args"') ||
    line.includes('"type"') ||
    line.includes('"data"') ||
    line.includes('"bufnum"') ||
    line.includes('"amp"') ||
    line.includes('"pan"') ||
    line.includes('"rate"') ||
    line.includes('"startPos"') ||
    line.includes('"duration"') ||
    line.includes('"threshold"') ||
    line.includes('"ratio"') ||
    line.includes('"attack"') ||
    line.includes('"release"') ||
    line.includes('"makeupGain"') ||
    line.includes('"level"') ||
    line.includes('"/') ||
    line.includes('orbitPlayBuf') ||
    line.includes('fxCompressor') ||
    line.includes('fxLimiter') ||
    line.includes('fxNormalizer') ||
    line.includes('Number of Devices:') ||
    line.includes('Input Device') ||
    line.includes('Output Device') ||
    line.includes('Streams:') ||
    line.includes('channels') ||
    line.includes('SC_AudioDriver:') ||
    line.includes('PublishPortToRendezvous') ||
    trimmed === '✓' ||
    trimmed === '}' ||
    trimmed === ']' ||
    trimmed === '{' ||
    trimmed === '[' ||
    trimmed.startsWith('}') ||
    trimmed.startsWith(']') ||
    trimmed.match(/^\d+\s*:/) ||
    trimmed.match(/^-?\d+(\.\d+)?,?$/) ||
    trimmed === ''
  ) {
    return true
  }

  return false
}

// ---- Handler-body crash containment (#527 review round 4 Important #1) ----
//
// setupStdoutHandler / setupStderrHandler / setupExitHandler /
// setupStdinErrorHandler / setupErrorHandler register listener bodies
// directly on Node stream/process events. There is no
// `process.on('uncaughtException', ...)` anywhere in this extension, so an
// exception that escapes ANY of these five listener bodies is not contained
// by anything OrbitScore controls.
//
// #534: what happens next past that point is NOT settled, and this comment
// deliberately does not assert either way. PR #527's bot review claimed the
// previous (unguarded) code let such an exception crash the extension host
// outright; a later accept audit countered that the extension host installs
// its own `uncaughtException` handler at bootstrap and, in many cases, logs
// and continues instead of crashing. Neither claim has been verified here
// against the extension host's actual bootstrap source — treat both as
// unconfirmed. What IS certain regardless of which is true: an uncontained
// exception here escapes `get_log` (this project's convention for "loud" —
// see CLAUDE.md's testing discipline notes), so containment is worth having
// independent of whether the crash claim turns out to be right. At minimum,
// it can crash the host; at minimum, it makes the failure invisible to
// `get_log`. `transportStatusText`'s exhaustiveness guard (#527 review
// Important #2, above) was the first piece of code on this path that can
// deliberately `throw`, but the danger it exposed is general: ANY exception
// here (a null UI element, a bridge method throwing, etc.) carries the same
// risk.
//
// `logHandlerFailure` catches and records loud, marker-prefixed failures
// (including the stack trace, for root-causing) instead of re-throwing —
// re-throwing would defeat the purpose. Per this project's convention,
// writing loudly to `outputChannel` IS the loud-failure behavior, not a
// silent swallow — provided `outputChannel` itself is reachable (see the
// null-channel handling below).
//
// #527 review round 5 Minor #1: `logHandlerFailure` is itself called from
// inside every one of those catch blocks — if ITS body threw (e.g. a future
// VS Code API change makes `outputChannel.appendLine` throw, or a test fake
// does), the exception would re-escape the very catch block that was
// supposed to contain it, defeating the whole mechanism. The inner
// try/catch below makes `logHandlerFailure` self-contained: if writing to
// `outputChannel` fails, it falls back to `console.error` instead of
// propagating. That fallback is deliberately a single, non-throwing
// primitive call — there is no safe place left to report a failure of the
// fallback itself.
//
// #534: a null `outputChannel` is a SEPARATE failure mode from
// `appendLine` throwing — `outputChannel?.appendLine(...)` on a null
// channel is a silent no-op via optional chaining, so the `catch` block
// below (which only ever sees thrown exceptions) was never reached for that
// case, and the failure vanished with no `console.error` fallback either.
// That defeats the one function whose entire job is to make failures loud,
// so the null case is now checked explicitly instead of relying on the
// exception path to catch it.
export function logHandlerFailure(handlerName: string, err: unknown): void {
  try {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error && err.stack ? err.stack : '(no stack trace available)'
    if (!outputChannel) {
      // Defensive dead code in production; reachable only through the
      // test-only __setOutputChannelForTest(null) reset hook.
      console.error(`🛑 internal error in ${handlerName} (no output channel to log to):`, err)
      return
    }
    outputChannel.appendLine(`🛑 internal error in ${handlerName}: ${message}`)
    outputChannel.appendLine(stack)
  } catch (loggingErr) {
    console.error(
      `🛑 internal error in ${handlerName} (and outputChannel logging itself failed):`,
      err,
      loggingErr,
    )
  }
}

/**
 * Setup stdout handler for engine process.
 */
export function setupStdoutHandler(process: child_process.ChildProcess, debugMode: boolean): void {
  // #773: Bridge envelopes are line-framed, but stdout data events are not.
  // Keep this buffer inside the handler so a stale process can never donate a
  // partial line to the current process. Only bridge dispatch is buffered:
  // applyEngineStdoutChunk still receives each raw chunk immediately below.
  const bridgeLines = createLinePrefixer((rawLine) => {
    const trimmedLine = rawLine.trim()
    const isCurrent = engineProcess === process
    if (trimmedLine.startsWith('{"savePluginState"')) {
      const parsed = isCurrent && pluginStateBridge.handleLine(rawLine)
      if (!parsed && isCurrent) {
        outputChannel?.appendLine(
          `⚠️ received a malformed //#savePluginState result line: ${rawLine}`,
        )
      }
    } else if (trimmedLine.startsWith('{"pluginUi"')) {
      const parsed = isCurrent && pluginUiBridge.handleLine(rawLine)
      if (!parsed && isCurrent) {
        outputChannel?.appendLine(`⚠️ received a malformed //#pluginUi result line: ${rawLine}`)
      }
    } else if (trimmedLine.startsWith('{"evalMark"')) {
      // 🔴 #614: この分岐は**独立していなければならない**。最初は `{"pluginUi"` 分岐の中に
      // 相乗りさせてしまい、`{"evalMark"` 行は prefix チェーンをすり抜けて一度も
      // dispatch されなかった（ユニットテストは全て緑・実機 E2E だけが捕まえた）。
      const parsed = isCurrent && evalMarkBridge.handleLine(rawLine)
      if (!parsed && isCurrent) {
        outputChannel?.appendLine(`⚠️ received a malformed //#evalMark result line: ${rawLine}`)
      }
    } else if (trimmedLine.startsWith('{"engineState"')) {
      const parsed = isCurrent && engineStateBridge.handleLine(rawLine)
      if (!parsed && isCurrent) {
        outputChannel?.appendLine(
          `⚠️ received a malformed //#getEngineState result line: ${rawLine}`,
        )
      }
    }
  })
  // Decode only the buffered bridge-dispatch path across Buffer boundaries. The log/playhead path
  // below intentionally keeps its historical per-chunk `data.toString()` timing and values.
  // stderr has the same UTF-8 boundary hazard but remains out of scope for this change.
  const bridgeDecoder = new StringDecoder('utf8')

  process.stdout?.on('error', (err) => {
    logHandlerFailure('setupStdoutHandler', err)
  })
  process.stdout?.on('data', (data) => {
    try {
      const output = data.toString()
      const lines: string[] = output.split('\n')

      // Identity-guarded via applyEngineStdoutChunk — see its docstring in
      // engine-lifecycle.ts for the #528 stop→start race this protects against
      // (same mechanism as setupExitHandler/setupStdinErrorHandler below).
      const isCurrent = engineProcess === process

      const bridgeOutput = bridgeDecoder.write(data)
      if (bridgeOutput) bridgeLines.push(bridgeOutput)

      applyEngineStdoutChunk(output, lines, isCurrent, {
        handleStep: handleStepLine,
        clearSequence: clearPlayheadForSequence,
        clearAllPlayheads: clearAllPlayheadDecorations,
        handleSelectAudioDeviceLine: (rawLine) => selectAudioDeviceBridge.handleLine(rawLine),
        warnMalformedSelectAudioDeviceLine: (rawLine, stale) => {
          outputChannel?.appendLine(
            `⚠️ received a malformed //#selectAudioDevice result line${
              stale ? ' from a stale engine' : ''
            } (possible chunk-boundary split): ${rawLine}`,
          )
        },
        transcribeLog: () => {
          // Second pass over the SAME `lines` array classifyEngineStdoutLine()
          // (inside applyEngineStdoutChunk) already scanned — not a re-split of
          // `output`. Unlike before this lifecycle extraction — when a stale
          // process's line loop ran zero iterations — this now always runs,
          // current or stale: the malformed-//#selectAudioDevice diagnostic
          // must see stale output too (#527 review Important #1).
          if (!debugMode) {
            const filteredOutput = lines.filter((line) => !shouldFilterLine(line)).join('\n')
            if (filteredOutput.trim()) outputChannel?.append(filteredOutput + '\n')
          } else {
            outputChannel?.append(output)
          }
        },
        // #527 review Important #2: rendering delegated to transportStatusText()
        // (engine-lifecycle.ts) — an exhaustive switch, not a ternary, so a
        // state value outside 'playing' | 'ready' throws instead of silently
        // displaying "Ready". That throw is caught by the try/catch wrapping
        // this whole listener body (#527 review round 4 Important #1) — it
        // reaches `logHandlerFailure` below, NOT the extension host.
        setTransportStatus: (state) => {
          setTransportPlaying(state === 'playing')
          statusBarItem!.text = transportStatusText(state, debugMode)
        },
      })
    } catch (err) {
      logHandlerFailure('setupStdoutHandler', err)
    }
  })
  process.stdout?.on('end', () => {
    try {
      const bridgeRemainder = bridgeDecoder.end()
      if (bridgeRemainder) bridgeLines.push(bridgeRemainder)
      bridgeLines.flush()
    } catch (err) {
      logHandlerFailure('setupStdoutHandler', err)
    }
  })
}

/**
 * chunk 列を**行**に整え、完成した行だけを `emit` へ渡す。未完了の末尾は次の chunk まで持ち越す。
 *
 * 🔴 なぜ要るか（#756）: `setupStderrHandler` は `outputChannel.append('ERROR: ' + chunk)` と
 * **chunk 単位**で前置していた。1 つの chunk に複数行入ると 2 行目以降に `ERROR:` が付かず、
 * gated E2E の ERROR 会計（`countErrors` / `newErrorLines`）が**構造的に過小カウント**する
 * （= 偽緑）。実測 2026-09-05: デバイス切替の失敗を daemon と engine が別々に記録したのに
 * `ERROR:` が付いたのは片方だけだった。
 *
 * 🔴 素朴な `split('\n')` では直らない。**chunk 境界は行境界と一致しない**ので、行の後半が
 * 独立した「行」として扱われ `ERROR:` が二重に付く。`partial` を持ち越すのが要点。
 *
 * 🔴 `flush()` を持つ理由: 行に整えると、**改行で終わらない最後の出力**が buffer に残ったまま
 * プロセスが終わる。それは過小カウントを直すはずのこの変更が**逆方向に**同じ穴を開けること
 * になる。`end` で必ず吐き出す。
 *
 * 🔴 **「chunk → 行」の経路は合計 4 つある**。この関数だけを直して全部揃ったと思わないこと:
 *
 * 1. ここ `createLinePrefixer` — engine stderr を行へ戻す（#756）。
 * 2. `packages/engine/src/audio/rust-engine/daemon-client.ts` の
 *    `createDaemonStderrLineRouter` — daemon stderr の同型実装（#777）。拡張パッケージは
 *    `@orbitscore/engine` に依存しないので今は共有できない。
 * 3. 同ファイルの `setupStdoutHandler` — bridge dispatch だけをこの関数で行へ戻す（#773）。
 *    生 chunk とその `output.split('\n')` は従来どおり即座に `applyEngineStdoutChunk` へ渡し、
 *    ログ転写と playhead / `//#selectAudioDevice` 処理の呼び出し規約は変えない。
 * 4. `activate()` 冒頭の output-channel ring proxy — `append` を `value.split('\n')` して
 *    `get_log` 用 ring へ写す。これは現時点で issue 未追跡である。
 *
 * **改行コード・空行・末尾 flush の判断は 4 箇所すべてへ波及しうる**。特に daemon 側には
 * `flush()` が無く、panic が改行なしで終わると最後の 1 行を落とす（#777）。
 *
 * 空行は emit しない。`ERROR: ` だけの行を作ると `countErrors` が**水増し**される。
 */
export function createLinePrefixer(emit: (line: string) => void): {
  push: (chunk: string) => void
  flush: () => void
} {
  let partial = ''
  return {
    push(chunk: string): void {
      partial += chunk
      const lines = partial.split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() !== '') emit(line)
      }
    },
    flush(): void {
      const remaining = partial
      partial = ''
      if (remaining.trim() !== '') emit(remaining)
    },
  }
}

/**
 * Setup stderr handler for engine process.
 *
 * #527 review round 5 Minor #2: wrapped in the same try/catch +
 * `logHandlerFailure` containment as the other three listener bodies above —
 * this one had been left unwrapped despite the crash-containment note two
 * functions up describing the danger in general terms for "every listener
 * body registered on the engine process". The output channel has no realistic
 * throw path today, so that part is a symmetry fix, not a fix for an observed
 * failure.
 *
 * 🔴 #756: 前置は `createLinePrefixer` を通して**行単位**で行う（chunk 単位だと同じ chunk の
 * 2 行目以降に `ERROR:` が付かず、gated E2E の ERROR 会計が構造的に過小カウントする）。
 */
export function setupStderrHandler(process: child_process.ChildProcess): void {
  const prefixer = createLinePrefixer((line) => {
    outputChannel?.appendLine(`ERROR: ${line}`)
  })
  process.stderr?.on('error', (err) => {
    logHandlerFailure('setupStderrHandler', err)
  })
  process.stderr?.on('data', (data) => {
    try {
      prefixer.push(data.toString())
    } catch (err) {
      logHandlerFailure('setupStderrHandler', err)
    }
  })
  // 改行で終わらなかった最後の 1 行を取りこぼさない。
  process.stderr?.on('end', () => {
    try {
      prefixer.flush()
    } catch (err) {
      logHandlerFailure('setupStderrHandler', err)
    }
  })
}

/**
 * Setup stdin 'error' handler for engine process.
 *
 * #501 review Important #2: an unhandled 'error' event on a stream crashes the
 * process. stdin can emit this independently of the 'exit' event (e.g. EPIPE if
 * the engine's stdin closes before we stop writing to it).
 */
export function setupStdinErrorHandler(process: child_process.ChildProcess): void {
  process.stdin?.on('error', (err) => {
    try {
      // Identity-guarded via applyEngineStdinError — see its docstring in
      // engine-lifecycle.ts for the #528 stop→start race this protects against.
      applyEngineStdinError(err.message, engineProcess === process, {
        logStdinError: (message) => outputChannel?.appendLine(`⚠️ engine stdin error: ${message}`),
        drainDeviceBridge: (reason) => {
          selectAudioDeviceBridge.drainAll(reason)
          pluginStateBridge.drainAll(reason)
          pluginUiBridge.drainAll(reason)
          evalMarkBridge.drainAll(reason)
          engineStateBridge.drainAll(reason)
        },
      })
    } catch (innerErr) {
      logHandlerFailure('setupStdinErrorHandler', innerErr)
    }
  })
}

export function engineTerminationEffects(): Omit<EngineExitEffects, 'logExit'> {
  return {
    clearEngineState: () => {
      setEngineProcess(null)
      setLiveCodingMode(false)
      setGlobalInitialized(false)
      setTransportPlaying(false)
    },
    clearAllPlayheads: clearAllPlayheadDecorations,
    drainDeviceBridge: (reason) => {
      selectAudioDeviceBridge.drainAll(reason)
      pluginStateBridge.drainAll(reason)
      pluginUiBridge.drainAll(reason)
      evalMarkBridge.drainAll(reason)
      engineStateBridge.drainAll(reason)
    },
    showStoppedStatus: () => {
      statusBarItem!.text = '🎵 OrbitScore: Stopped'
      statusBarItem!.tooltip = 'Click to start engine'
    },
    refreshEngineView: () => engineViewProvider?.refresh(),
  }
}

/**
 * Setup exit handler for engine process.
 */
export function setupExitHandler(process: child_process.ChildProcess): void {
  process.on('exit', (code) => {
    try {
      // Identity-guarded via applyEngineExit — see its docstring in
      // engine-lifecycle.ts for the #528 stop→start race this protects against.
      applyEngineExit(code, engineProcess === process, {
        logExit: (exitCode) =>
          outputChannel?.appendLine(`\n🛑 Engine process exited with code ${exitCode}`),
        ...engineTerminationEffects(),
      })
    } catch (err) {
      logHandlerFailure('setupExitHandler', err)
    }
  })
}

/**
 * Setup `'error'` handler for the engine `ChildProcess` itself (#533).
 *
 * `ChildProcess` is an `EventEmitter`: an `'error'` event with no listener is
 * thrown as an uncaught exception by EventEmitter's own contract — this is a
 * DIFFERENT hazard from the "no `process.on('uncaughtException', ...)`"
 * concern documented above the other four handlers, and it existed even
 * before those four were wrapped in try/catch, because nothing was
 * listening for `'error'` at all. A spawn failure (`ENOENT` / `EMFILE` /
 * `EAGAIN`) emits `'error'`, and per Node's docs `'exit'` may never fire for
 * that same failure, so `setupExitHandler` above cannot be relied on to
 * clean up here.
 */
export function setupErrorHandler(process: child_process.ChildProcess): void {
  process.on('error', (err) => {
    try {
      // Identity-guarded via applyEngineError — see its docstring in
      // engine-lifecycle.ts for the #528-style stale-process race this
      // protects against (same mechanism as the other four handlers above).
      applyEngineError(err, engineProcess === process, {
        logError: (error) =>
          outputChannel?.appendLine(`\n🛑 Engine process error: ${error.message}`),
        ...engineTerminationEffects(),
      })
    } catch (innerErr) {
      logHandlerFailure('setupErrorHandler', innerErr)
    }
  })
}
