/**
 * Pure analysis functions for OrbitScore document diagnostics.
 *
 * VS Code API に依存しないロジックを切り出し、vitest からユニットテスト可能にする。
 * `extension.ts` の `updateDiagnostics()` がこれらを呼び出して `vscode.Diagnostic` に変換する。
 */

/**
 * Diagnostic 用の位置情報 (0-indexed)。
 */
export type DiagnosticIssue = {
  line: number
  startCol: number
  endCol: number
  message: string
}

/**
 * `global` の state-setting メソッド一覧。
 *
 * Live coding の正攻法は「行を書き換えて再評価」なので、ファイル中で 1 回のみとする。
 *
 * `start` / `stop` は live coding のセッション制御 (途中で停止して再開) で複数回呼びたく
 * なる場面が想定されるが、OrbitScore では `LOOP()` / `RUN()` / `MUTE()` の uppercase
 * トランスポートコマンドが live 制御の主役であり、`global.start()` は engine 起動時の
 * 一度きりの初期化として扱う設計。よって start / stop も once-per-file の対象に含める。
 *
 * 例外:
 *   - `init global.seq` (sequence 宣言、複数必要)
 *   - `LOOP` / `RUN` / `MUTE` (uppercase 標準形)
 */
export const GLOBAL_ONCE_METHODS = new Set([
  'tempo',
  'beat',
  'audioPath',
  'start',
  'stop',
  'gain',
  'key',
  'normalizer',
  'limiter',
  'compressor',
  // LinkAudio mode declaration is a state setter (see DSL spec §8.1.1) and
  // therefore once-per-file like the other globals.
  'linkAudio',
])

/**
 * 行末コメントを除去する。
 *
 * 文字列リテラル内の `//` を誤って除去しないよう、簡易的に「クォート外で最初に現れる `//`」
 * を境界とする。完全な lexer ではないが、live coding の典型的な使い方には十分。
 */
function stripLineComment(line: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i]
    if (ch === '\\') {
      i++ // skip escaped char
      continue
    }
    if (!inDouble && ch === "'") inSingle = !inSingle
    else if (!inSingle && ch === '"') inDouble = !inDouble
    else if (!inSingle && !inDouble && ch === '/' && line[i + 1] === '/') {
      return line.slice(0, i)
    }
  }
  return line
}

/**
 * Detection: `global.<method>(` の重複呼び出し。
 *
 * @param text ドキュメント全体のテキスト
 * @returns 2 回目以降の出現位置にひもづく Diagnostic 候補
 */
export function analyzeGlobalOncePerFile(text: string): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = []
  const lines = text.split('\n')

  type CallLocation = { line: number; col: number; len: number }
  const callsByMethod = new Map<string, CallLocation[]>()
  const pattern = /\bglobal\s*\.\s*(\w+)\s*\(/g

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || raw.trim().startsWith('//')) continue
    const line = stripLineComment(raw)
    for (const m of line.matchAll(pattern)) {
      const method = m[1]
      if (!GLOBAL_ONCE_METHODS.has(method)) continue
      const list = callsByMethod.get(method) ?? []
      list.push({ line: i, col: m.index ?? 0, len: m[0].length })
      callsByMethod.set(method, list)
    }
  }

  for (const [method, calls] of callsByMethod) {
    if (calls.length <= 1) continue
    for (let k = 1; k < calls.length; k++) {
      const c = calls[k]
      issues.push({
        line: c.line,
        startCol: c.col,
        endCol: c.col + c.len,
        message: `Duplicate global.${method}(). Live coding pattern: edit the existing line instead of adding a new one.`,
      })
    }
  }

  return issues
}

/**
 * Detection: `global.audioPath()` が最初の `\.audio("<相対パス>")` より前にあること。
 *
 * 絶対パス (POSIX `/`, `~/`、Windows `C:\`) は audioPath 不要のためスキップ。
 *
 * @param text ドキュメント全体のテキスト
 * @returns ordering 違反の出現位置にひもづく Diagnostic 候補
 */
export function analyzeAudioPathOrdering(text: string): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = []
  const lines = text.split('\n')

  // 最初の global.audioPath() 出現行を取得
  const audioPathPattern = /\bglobal\s*\.\s*audioPath\s*\(/
  let firstAudioPathLine = -1
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || raw.trim().startsWith('//')) continue
    const line = stripLineComment(raw)
    if (audioPathPattern.test(line)) {
      firstAudioPathLine = i
      break
    }
  }

  const audioCallPattern = /\.audio\s*\(\s*["']([^"']+)["']\s*\)/g
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || raw.trim().startsWith('//')) continue
    const line = stripLineComment(raw)
    // Skip lines that are themselves global.audioPath() declarations
    if (/\bglobal\s*\.\s*audioPath\s*\(/.test(line)) continue
    for (const m of line.matchAll(audioCallPattern)) {
      const arg = m[1]
      const isAbsolute =
        arg.startsWith('/') ||
        arg.startsWith('~/') ||
        arg.startsWith('~\\') ||
        /^[A-Za-z]:[\\/]/.test(arg)
      if (isAbsolute) continue
      const isBeforeOrMissing = firstAudioPathLine === -1 || i < firstAudioPathLine
      if (!isBeforeOrMissing) continue
      const message =
        firstAudioPathLine === -1
          ? 'Relative audio path requires global.audioPath() to be set first (no audioPath found in file).'
          : `Relative audio path used before global.audioPath() (declared at line ${firstAudioPathLine + 1}). Move audioPath() above this audio() call.`
      const startCol = m.index ?? 0
      issues.push({
        line: i,
        startCol,
        endCol: startCol + m[0].length,
        message,
      })
    }
  }

  return issues
}

/**
 * Detection: any `\.output(...)` call when the file does not declare
 * `global.linkAudio()`. Per DSL spec §8.1.2 the channel name is recorded but
 * has no effect until LinkAudio mode is enabled, so the user almost certainly
 * forgot the declaration. Emit one warning per orphaned `.output()` call so
 * each location is surfaced individually.
 *
 * @param text ドキュメント全体のテキスト
 * @returns LinkAudio mode が宣言されていない状態での `.output()` 呼出位置
 */
export function analyzeOutputWithoutLinkAudio(text: string): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = []
  const lines = text.split('\n')

  const linkAudioPattern = /\bglobal\s*\.\s*linkAudio\s*\(/
  let hasLinkAudio = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || raw.trim().startsWith('//')) continue
    const line = stripLineComment(raw)
    if (linkAudioPattern.test(line)) {
      hasLinkAudio = true
      break
    }
  }
  if (hasLinkAudio) return issues

  const outputCallPattern = /\.output\s*\(\s*["']([^"']*)["']\s*\)/g
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || raw.trim().startsWith('//')) continue
    const line = stripLineComment(raw)
    for (const m of line.matchAll(outputCallPattern)) {
      const startCol = m.index ?? 0
      issues.push({
        line: i,
        startCol,
        endCol: startCol + m[0].length,
        message:
          'seq.output() requires global.linkAudio() to be declared in this file. Without LinkAudio mode the channel name is recorded but the sequence still routes through the hardware bus.',
      })
    }
  }

  return issues
}
