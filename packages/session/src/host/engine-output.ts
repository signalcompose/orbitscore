/**
 * engine の出力の口（`packages/engine` の `audio/engine-backend.ts` の `host`）を層 2 で受ける
 * （設計 848 台帳 P-07・束 S-eval #1022 の N1-d3）。
 *
 * engine は人間向けのログ行を `host.log` / `warn` / `error`（`console` と同じ引数）で、鳴った step を
 * `host.step` で出す。層 2 は `setHostOutput` でここの受け手を差し込み、ログ行は `log.line` の分類へ、
 * step は `transport.step` へ回す。process の console は横取りしない（段階 1 の P-07 の横取りを置き換えた）。
 */
import util from 'node:util'

import type { HostOutput } from '@orbitscore/engine/dist/audio/engine-backend'

import type { OutputStream } from './log-classify'

export interface StepEvent {
  seq: string
  argPath: string
  atEpochMs: number
}

export interface EngineOutputHandlers {
  /** 空でない 1 行ずつ（`log` は stdout・`warn` / `error` は stderr。Node の console と同じ振り分け）。 */
  line(stream: OutputStream, text: string): void
  step(event: StepEvent): void
}

/** engine の `host` に差し込む受け手。引数は `console` と同じ規則（`util.format`）で 1 本の文字列にする。 */
export function createHostOutput(handlers: EngineOutputHandlers): HostOutput {
  const lines =
    (stream: OutputStream) =>
    (...args: unknown[]) => {
      for (const line of util.format(...args).split('\n')) {
        if (line.trim() !== '') handlers.line(stream, line)
      }
    }
  return {
    log: lines('stdout'),
    warn: lines('stderr'),
    error: lines('stderr'),
    step: (event) => handlers.step(event),
  }
}

/**
 * engine の既定の口（console）が書く `[STEP] <seq> <argPath> <atEpochMs>` の文法。層 2 では step は
 * 型つきで届くので、ログ行にこの形が来るのは engine のどこかが口を通らずに書いた時だけ。
 */
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
