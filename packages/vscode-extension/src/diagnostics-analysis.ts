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
 * 0-indexed line of the first non-comment match for `pattern`, or -1 if
 * the pattern never appears.
 */
function findFirstMatchingLine(lines: string[], pattern: RegExp): number {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || raw.trim().startsWith('//')) continue
    if (pattern.test(stripLineComment(raw))) return i
  }
  return -1
}

// Module-scope DSL pattern shared by all analyzers that look for the
// LinkAudio mode declaration. Hoisted so the syntax has a single point of
// change if the DSL ever evolves.
const LINK_AUDIO_PATTERN = /\bglobal\s*\.\s*linkAudio\s*\(/

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

  const audioPathPattern = /\bglobal\s*\.\s*audioPath\s*\(/
  const firstAudioPathLine = findFirstMatchingLine(lines, audioPathPattern)

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
 * Detection: any `\.output(...)` call that is not preceded by a
 * `global.linkAudio()` declaration on an earlier line. Per DSL spec §8.1.2 the
 * declaration is order-sensitive — a sequence's `.output()` only resolves
 * correctly once LinkAudio mode is on. Two cases this catches:
 *
 *   1. `.output()` with no `global.linkAudio()` anywhere in the file (the
 *      original orphan case).
 *   2. `.output()` appearing on a line BEFORE the first `global.linkAudio()`
 *      declaration (the order-violation case — flagged because live coding
 *      reads top-to-bottom and the sequence will be evaluated against an
 *      unset mode).
 *
 * @param text ドキュメント全体のテキスト
 * @returns LinkAudio mode が `.output()` より前に宣言されていない位置
 */
export function analyzeOutputWithoutLinkAudio(text: string): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = []
  const lines = text.split('\n')

  // -1 = not found anywhere. Otherwise the 0-indexed line of the first call.
  const firstLinkAudioLine = findFirstMatchingLine(lines, LINK_AUDIO_PATTERN)

  const outputCallPattern = /\.output\s*\(\s*["']([^"']*)["']\s*\)/g
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || raw.trim().startsWith('//')) continue
    // .output() that comes after the linkAudio() declaration is fine.
    if (firstLinkAudioLine !== -1 && i >= firstLinkAudioLine) continue
    const line = stripLineComment(raw)
    for (const m of line.matchAll(outputCallPattern)) {
      const startCol = m.index ?? 0
      const message =
        firstLinkAudioLine === -1
          ? 'seq.output() requires global.linkAudio() to be declared in this file. Without LinkAudio mode the channel name has no effect.'
          : `seq.output() appears before global.linkAudio() (declared at line ${firstLinkAudioLine + 1}). LinkAudio mode must be declared first or the sequence routes hardware on first evaluation.`
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
 * Detection: `.output("")` or whitespace-only argument. This mirrors the
 * runtime guard in `Sequence.output()` — without an edit-time analyzer,
 * the user types `.output("")`, sees no squiggle, then hits a runtime throw
 * with no idea why. Flagged independently of `global.linkAudio()` because
 * the runtime throw fires regardless of mode.
 *
 * @param text ドキュメント全体のテキスト
 * @returns 空文字列 / whitespace のみを引数とする `.output()` 呼出位置
 */
export function analyzeEmptyOutputArg(text: string): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = []
  const lines = text.split('\n')

  // Match .output("") and .output("   ") (whitespace-only) — distinct from
  // the LinkAudio analyzers which only care about the presence of any
  // .output() call regardless of argument.
  const emptyOutputPattern = /\.output\s*\(\s*["']\s*["']\s*\)/g

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || raw.trim().startsWith('//')) continue
    const line = stripLineComment(raw)
    for (const m of line.matchAll(emptyOutputPattern)) {
      const startCol = m.index ?? 0
      issues.push({
        line: i,
        startCol,
        endCol: startCol + m[0].length,
        message:
          'seq.output() requires a non-empty channel name. An empty or whitespace-only ' +
          'argument throws at runtime — drop the .output() call or supply a name like ' +
          '.output("kick").',
      })
    }
  }

  return issues
}

/**
 * Detection: any `init global.seq` chain that has `.play(...)` (i.e. produces
 * audio) but never calls `.output(...)`, when the file declares
 * `global.linkAudio()`. Per DSL spec §8.1.2 strict-mode contract, every
 * sequence in a LinkAudio file must declare a destination channel — silent
 * fallback to hardware is forbidden because hardware/LinkAudio cannot mix
 * within a single file. This is the edit-time counterpart to
 * `Sequence.resolveDispatchChannel()`'s runtime throw.
 *
 * Note: detection is name-scoped — we look at each `var X = init global.seq`
 * declaration and check whether the file contains any `X.output(` reference.
 * Chained-on-declaration calls (`var X = init global.seq.audio(...).output(...)`)
 * are not in current example style but are also covered because the regex
 * matches `<name>.output(` anywhere downstream.
 *
 * @param text ドキュメント全体のテキスト
 * @returns LinkAudio mode 宣言下で `.output()` を持たない sequence の `.play(` 呼出位置
 */
export function analyzeLinkAudioMissingOutput(text: string): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = []
  const lines = text.split('\n')

  // Bail early if the file does not declare LinkAudio — the strict-mode
  // requirement does not apply.
  if (findFirstMatchingLine(lines, LINK_AUDIO_PATTERN) === -1) return issues

  // Collect sequence variable names. Both `init global.seq` (current) and
  // `init GLOBAL.seq` (legacy, still supported by the parser) are matched.
  const seqDeclPattern = /\bvar\s+(\w+)\s*=\s*init\s+(?:global|GLOBAL)\s*\.\s*seq\b/
  const sequenceNames = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || raw.trim().startsWith('//')) continue
    const m = stripLineComment(raw).match(seqDeclPattern)
    if (m) sequenceNames.add(m[1])
  }
  if (sequenceNames.size === 0) return issues

  // Precompile per-sequence patterns once. Without this, the inner regex
  // would be compiled on every line × every name on every keystroke, since
  // updateDiagnostics fires on `onDidChangeTextDocument`. Word-boundary
  // anchored to avoid `kicker.output()` matching `kick`.
  const outputPatterns = new Map<string, RegExp>()
  for (const name of sequenceNames) {
    outputPatterns.set(name, new RegExp(`\\b${name}\\b[^\\n]*\\.output\\s*\\(`))
  }

  const namesWithOutput = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || raw.trim().startsWith('//')) continue
    const line = stripLineComment(raw)
    for (const [name, pattern] of outputPatterns) {
      if (pattern.test(line)) namesWithOutput.add(name)
    }
  }

  // MIDI sequences (`<name>.midi(...)`) emit to a MIDI bus, never to an SC audio
  // bus, so the strict-mode `.output()` requirement does not apply to them
  // (decision #14: MIDI と SC オーディオは併走可; spec §8.1.2 scopes the rule to
  // "発音 sequences"). Mirror the runtime exemption in
  // Sequence.resolveDispatchChannel() so a `.midi()` sequence in a LinkAudio file
  // is not flagged at edit time (#282).
  const namesWithMidi = new Set<string>()
  const midiPatterns = new Map<string, RegExp>()
  for (const name of sequenceNames) {
    midiPatterns.set(name, new RegExp(`\\b${name}\\b[^\\n]*\\.midi\\s*\\(`))
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || raw.trim().startsWith('//')) continue
    const line = stripLineComment(raw)
    for (const [name, pattern] of midiPatterns) {
      if (pattern.test(line)) namesWithMidi.add(name)
    }
  }

  const orphans = new Set<string>()
  for (const name of sequenceNames) {
    if (!namesWithOutput.has(name) && !namesWithMidi.has(name)) orphans.add(name)
  }
  if (orphans.size === 0) return issues

  const playPatterns = new Map<string, RegExp>()
  for (const name of orphans) {
    playPatterns.set(name, new RegExp(`\\b${name}\\s*\\.\\s*play\\s*\\(`, 'g'))
  }

  // Flag each `<orphan>.play(` call so the issue surfaces where audio is
  // actually produced. play() is the trigger for runtime dispatch resolution.
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || raw.trim().startsWith('//')) continue
    const line = stripLineComment(raw)
    for (const [name, pattern] of playPatterns) {
      for (const m of line.matchAll(pattern)) {
        const startCol = m.index ?? 0
        issues.push({
          line: i,
          startCol,
          endCol: startCol + m[0].length,
          message:
            `Sequence '${name}' has no .output() channel set, but global.linkAudio() is enabled. ` +
            `Add .output("name") to the sequence chain — hardware/LinkAudio mixing is forbidden ` +
            `within a LinkAudio file.`,
        })
      }
    }
  }

  return issues
}
