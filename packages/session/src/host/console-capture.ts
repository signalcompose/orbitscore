/**
 * engine が `console` に書く行を、層 2 の出力（`log.line` / `transport.step` / `transport.state`）へ
 * 受け取る（設計 848 §4.5.1 の末尾・台帳 P-07）。
 *
 * PROVISIONAL(P-07): `packages/engine` は `[STEP]`・人間向けのログ行・`[ERROR]` を `console.log` /
 * `console.error` へ直接書き、出力先を差し込む口が無い（`cli/` 以外で 31 ファイル 156 箇所）。層 2 は
 * engine を in-process で持つので、v1 は**この process の console を横取りして**行を分類するしか無い。
 * 最終形は engine に型付きの出力の口（step / log / diagnostic）を足して host が注入する形で、束 S-eval で
 * 入れる（既定の出力先は console のまま = 凍結版の振る舞いは変わらない）。その時このファイルを消す。
 *
 * 🔴 層 2 自身の行は console に書かない（横取りに混ざる）。層 2 の行は `LogHub` へ直接渡す。
 */
import util from 'node:util'

import type { OutputStream } from './log-classify'

type ConsoleMethod = 'log' | 'info' | 'debug' | 'error' | 'warn'

/** Node の `console.log` / `info` / `debug` は stdout、`error` / `warn` は stderr に書く。 */
const STREAM_OF: Record<ConsoleMethod, OutputStream> = {
  log: 'stdout',
  info: 'stdout',
  debug: 'stdout',
  error: 'stderr',
  warn: 'stderr',
}

/**
 * console を横取りし、空でない 1 行ずつ `onLine` へ渡す。戻り値で元に戻す。
 * `passthrough` が true なら元の console にも書く（headless の CLI で人が見るため）。
 */
export function captureConsole(
  onLine: (stream: OutputStream, text: string) => void,
  options: { passthrough?: boolean; target?: Console } = {},
): () => void {
  const target = options.target ?? console
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>()
  for (const method of Object.keys(STREAM_OF) as ConsoleMethod[]) {
    const original = target[method].bind(target) as (...args: unknown[]) => void
    originals.set(method, original)
    target[method] = (...args: unknown[]) => {
      const text = util.format(...args)
      for (const line of text.split('\n')) {
        if (line.trim() !== '') onLine(STREAM_OF[method], line)
      }
      if (options.passthrough) original(...args)
    }
  }
  return () => {
    for (const [method, original] of originals) target[method] = original
  }
}

export interface StepEvent {
  seq: string
  argPath: string
  atEpochMs: number
}

/** engine の `[STEP] <seq> <argPath> <atEpochMs>`（`rust-engine-player.ts` / `midi-scheduler.ts`）。 */
export function parseStepLine(line: string): StepEvent | null {
  const match = /^\[STEP\]\s+(\S+)\s+(\S+)\s+(-?\d+(?:\.\d+)?)\s*$/.exec(line.trim())
  if (!match) return null
  return { seq: match[1]!, argPath: match[2]!, atEpochMs: Number(match[3]) }
}

/**
 * transport の状態の変化を表す行（凍結版 `engine-lifecycle.ts` の `applyEngineStdoutChunk` と同じ語）。
 * 変化を表さない行は null。
 */
export function transportChange(line: string): 'playing' | 'ready' | null {
  if (line.includes('✅ Global running') || line.includes('▶ Global')) return 'playing'
  if (line.includes('✅ Global stopped') || line.includes('⏹ Global')) return 'ready'
  return null
}
