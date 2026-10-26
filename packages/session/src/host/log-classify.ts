/**
 * engine の出力の行を `log.line` の `level` / `kind` と、`get_log` の ring に積む文字列へ分ける
 * （設計 848 §5.3.6）。**分類は層 2 が行い、クライアントは分類しない。**
 *
 * ring の中身は凍結版と同じ規則で同じ文字列にする（`get_log` の戻りは MCP の v1 関門に入る・
 * §6.1・台帳 P-03）:
 * - debug でない時: stdout 由来の行は凍結版 `shouldFilterLine` が「出す」行だけ、stderr 由来の行は全部
 * - debug の時: stdout 由来の行は全部（`[STEP]` を含む）、stderr 由来の行は全部
 * - stderr 由来の行は `ERROR: ` を前置する（凍結版 `createLinePrefixer`・`engine-handlers.ts`）
 *
 * `level` は §5.3.6 の規則: `diagnostic` と `stall` は error / daemon は tracing の level（読めない行は
 * error）/ engine は `shouldFilterLine` が出す行を info（`⚠️` を含めば warn）、捨てる行を debug。
 * ring に積むかどうかは level ではなく上の凍結版の規則で決める（daemon の DEBUG 行のように、level が
 * debug でも凍結版が ring に入れていた行があるため）。
 */
import { isDaemonNonErrorTracingLine } from '@orbitscore/engine/dist/audio/rust-engine/daemon-stderr-lines'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type LogKind = 'diagnostic' | 'engine' | 'daemon' | 'stall' | 'session'
export type OutputStream = 'stdout' | 'stderr'

export interface ClassifiedLine {
  level: LogLevel
  kind: LogKind
  text: string
  /** `get_log` の ring に積む文字列。積まない行は null。 */
  ringText: { normal: string | null; debug: string }
}

/**
 * 凍結版 `packages/vscode-extension/src/engine-handlers.ts` の `shouldFilterLine` の写し（true = 捨てる）。
 * `tests/session/log-classify.spec.ts` が凍結版と同じ答えを返すことを事例で確かめる。
 */
export function shouldFilterLine(line: string): boolean {
  const trimmed = line.trim()
  if (line.includes('[STEP]')) return true
  if (
    trimmed.startsWith('{"savePluginState"') ||
    trimmed.startsWith('{"pluginUi"') ||
    trimmed.startsWith('{"evalMark"') ||
    trimmed.startsWith('{"engineState"')
  ) {
    return true
  }
  // 🎚️ (U+1F39A) は `"type"` の部分一致より前に残す（#964）。🎛️ は U+1F39B で別の文字。
  if (line.includes('ERROR') || line.includes('⚠️') || line.includes('🎛️') || line.includes('🎚️')) {
    return false
  }
  if (
    line.includes('🎵 OrbitScore') ||
    line.includes('✅ Initialized') ||
    line.includes('✅ Mastering effect') ||
    line.includes('🎵 Live coding mode')
  ) {
    return false
  }
  if (
    line.includes('✅ Global running') ||
    line.includes('✅ Global stopped') ||
    line.includes('✅ Global starting')
  ) {
    return false
  }
  if (line.includes('▶ ') || line.includes('⏹ ') || line.includes('🔄 ')) return false
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

const DAEMON_PREFIX = '[daemon] '
// eslint-disable-next-line no-control-regex -- daemon の tracing が付ける ANSI 色コードを剥がす
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g

/** daemon の tracing 行の level token（`isDaemonNonErrorTracingLine` が認めた行だけ）。 */
function daemonTracingLevel(line: string): LogLevel {
  const plain = line.replace(ANSI_ESCAPE_RE, '')
  const token = /\b(TRACE|DEBUG|INFO|WARN)\b/.exec(plain)?.[1]
  if (token === 'WARN') return 'warn'
  if (token === 'INFO') return 'info'
  return 'debug'
}

function ringOf(stream: OutputStream, text: string): ClassifiedLine['ringText'] {
  if (stream === 'stderr') {
    const prefixed = `ERROR: ${text}`
    return { normal: prefixed, debug: prefixed }
  }
  return { normal: shouldFilterLine(text) ? null : text, debug: text }
}

/** engine の console に出た 1 行（`[STEP]` は呼び出し側が先に取り除く）を分類する。 */
export function classifyEngineLine(stream: OutputStream, text: string): ClassifiedLine {
  if (text.startsWith(DAEMON_PREFIX)) {
    const body = text.slice(DAEMON_PREFIX.length)
    // daemon-client.ts は非エラーの tracing 行を console.log へ、それ以外を console.error へ回す。
    const level: LogLevel =
      stream === 'stderr' || !isDaemonNonErrorTracingLine(body) ? 'error' : daemonTracingLevel(body)
    return { level, kind: 'daemon', text, ringText: ringOf(stream, text) }
  }
  if (stream === 'stderr') {
    return { level: 'error', kind: 'engine', text, ringText: ringOf(stream, text) }
  }
  const level: LogLevel = shouldFilterLine(text) ? 'debug' : text.includes('⚠️') ? 'warn' : 'info'
  return { level, kind: 'engine', text, ringText: ringOf(stream, text) }
}

/** 層 2 自身の行（受付口の診断・滞留の報告・session の行）を分類する。error は stderr 由来として扱う。 */
export function classifySessionLine(kind: LogKind, level: LogLevel, text: string): ClassifiedLine {
  const stream: OutputStream = level === 'error' ? 'stderr' : 'stdout'
  const ringText =
    stream === 'stderr'
      ? ringOf('stderr', text)
      : { normal: level === 'debug' ? null : text, debug: text }
  return { level, kind, text, ringText }
}
