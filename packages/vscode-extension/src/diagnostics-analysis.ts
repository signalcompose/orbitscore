/**
 * Pure analysis functions for OrbitScore document diagnostics.
 *
 * VS Code API に依存しないロジックを切り出し、vitest からユニットテスト可能にする。
 * `extension.ts` の `updateDiagnostics()` がこれらを呼び出して `vscode.Diagnostic` に変換する。
 */

import { extractDeclaredBusNames } from './dsl-completion-context'

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
 * `updateDiagnostics()` の対象となる文書かどうかの判定。
 *
 * `extension.ts` 側で onDidOpenTextDocument / onDidChangeTextDocument /
 * onDidCloseTextDocument / activation 時の初期パスの 4 箇所すべてから参照される
 * 単一の判定源 (#384)。vscode.TextDocument に依存させないため引数型は最小限の
 * shape のみ要求し、vscode モックなしで単体テスト可能にする。
 */
export function isOrbitscoreDocument(document: { languageId: string }): boolean {
  return document.languageId === 'orbitscore'
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
/**
 * #611 §2.1/§3.3: the names `output("…")` resolves BEFORE it ever reaches a LinkAudio channel.
 * A string that lands on one of these is a working mixer destination, so warning about
 * LinkAudio on it tells the user their working code does not work.
 *
 * 🔴 Resolution order is normative and LinkAudio is LAST:
 *   resolved OutputDest -> `"master"` -> declared sum/aux name -> `"L,R"` pair -> LinkAudio.
 * Keep this in step with `Sequence.resolveLineDest()` / `resolveNamedOutputDest()`; a name that
 * resolves earlier there but is missing here re-creates the exact defect this guard fixes.
 */
const PHYSICAL_PAIR_PATTERN = /^\d+\s*,\s*\d+$/
/** `global.sum("drums")` / `global.aux("verb")` — the string form. */
const MIXER_BUS_STRING_DECL = /\bglobal\.(?:sum|aux)\s*\(\s*["']([^"']+)["']/g
/** `var verb = mix.aux` — the variable NAME is the bus name (#459). */
const MIXER_BUS_VAR_DECL = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*mix\.(?:sum|aux)\b/g

/** Every mixer-bus name declared anywhere in the document, in either declaration form. */
function declaredMixerBusNames(lines: readonly string[]): ReadonlySet<string> {
  const names = new Set<string>()
  for (const raw of lines) {
    if (!raw || raw.trim().startsWith('//')) continue
    const line = stripLineComment(raw)
    for (const m of line.matchAll(MIXER_BUS_STRING_DECL)) names.add(m[1])
    for (const m of line.matchAll(MIXER_BUS_VAR_DECL)) names.add(m[1])
  }
  return names
}

export function analyzeOutputWithoutLinkAudio(text: string): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = []
  const lines = text.split('\n')

  // -1 = not found anywhere. Otherwise the 0-indexed line of the first call.
  const firstLinkAudioLine = findFirstMatchingLine(lines, LINK_AUDIO_PATTERN)

  // Collected over the WHOLE document, not just the lines above the call: a live-coding file is
  // re-evaluated as a whole and `global.sum(...)` is routinely written below the sequences that
  // target it. Flagging a name that the same file declares two lines later would be noise.
  const mixerBuses = declaredMixerBusNames(lines)

  const outputCallPattern = /\.output\s*\(\s*["']([^"']*)["']\s*\)/g
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw || raw.trim().startsWith('//')) continue
    // .output() that comes after the linkAudio() declaration is fine.
    if (firstLinkAudioLine !== -1 && i >= firstLinkAudioLine) continue
    const line = stripLineComment(raw)
    for (const m of line.matchAll(outputCallPattern)) {
      const target = m[1]
      // Resolves before LinkAudio -> it works, with or without a linkAudio() declaration.
      if (target === 'master' || mixerBuses.has(target) || PHYSICAL_PAIR_PATTERN.test(target)) {
        continue
      }
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

export type OutputRoutingDiagnosticIssue = DiagnosticIssue & {
  code: 'output-missing' | 'dry-not-routed'
  sequenceName: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 出口とみなすメソッドのパターン。**レシーバを含まない** — 行がどのシーケンスのものかは
 * 呼び出し側が別に判定するので、ここはチェーンのどの位置に来ても等しくマッチする。
 */
const MIDI_CALL = /\.\s*midi\s*\(/
const OUTPUT_CALL = /\.\s*output\s*\(/
const MASTER_ACCESS = /\.\s*master\b/
const SEND_CALL = /\.\s*send\s*\(\s*(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))/g
/** 診断の発火点。`replay(` を拾わないよう語境界を前に置く。 */
const PLAY_CALL = /\bplay\s*\(/g

/**
 * Find sounding sequence lines whose text declares no destination, plus the narrower aux-only
 * send case where the wet signal is routed but the dry signal probably was meant to remain.
 */
export function analyzeMissingOutput(text: string): OutputRoutingDiagnosticIssue[] {
  const lines = text.split('\n')
  const codeLines = lines.map((line) => stripLineComment(line))
  const sumNames = new Set(extractDeclaredBusNames(text, 'sum'))
  const auxNames = new Set(extractDeclaredBusNames(text, 'aux'))
  const sequenceNames = new Set<string>()
  const seqDeclPattern = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*init\s+(?:global|GLOBAL)\s*\.\s*seq\b/
  for (const line of codeLines) {
    const match = seqDeclPattern.exec(line)
    if (match?.[1]) sequenceNames.add(match[1])
  }

  const issues: OutputRoutingDiagnosticIssue[] = []
  // 🔴 レシーバの判定は **「行がこのシーケンスのものか」と「どのメソッドか」の 2 つ**に分ける。
  // 1 本の正規表現で兼ねると「名前の直後」しか見えず、`kick.audio("k.wav").send("verb", -6)`
  // の宛先が消えて、同じ意味の `kick.send("verb", -6)` と違う診断が出る。チェーン上の位置は
  // MX.3 の意味（プリ / ポスト）を持つが、**出口として数えるかどうかは位置に依らない**。
  // 実際に `.output(` だけがチェーン対応で、`send` / `master` / 裸形バス / `play` は直後だけを
  // 見ており、チェーン形の譜面に偽の `output-missing` を出していた（PR #885 のレビューで
  // code-reviewer と Fable 監査が独立に到達）。
  //
  // メソッド側のパターンはシーケンス名に依存しないのでモジュール定数に置く。バス名のパターンも
  // **文書ごとに 1 度だけ**組み立てる — 行ループの内側で `new RegExp` を呼ぶと、1 打鍵あたり
  // `シーケンス数 × 行数 × バス数` 回のコンパイルになる（診断は `onDidChangeTextDocument` で
  // 打鍵ごとに走る）。
  const sumPatterns = [...sumNames].map(
    (target) => [target, new RegExp(`\\.\\s*${escapeRegExp(target)}\\b`)] as const,
  )
  const auxPatterns = [...auxNames].map(
    (target) => [target, new RegExp(`\\.\\s*${escapeRegExp(target)}\\b`)] as const,
  )
  for (const name of sequenceNames) {
    const ownsLine = new RegExp(`\\b${escapeRegExp(name)}\\b`)
    const ownLines: Array<{ index: number; text: string }> = []
    for (let index = 0; index < codeLines.length; index += 1) {
      if (ownsLine.test(codeLines[index])) ownLines.push({ index, text: codeLines[index] })
    }
    if (ownLines.some(({ text }) => MIDI_CALL.test(text))) continue

    let hasDestination = false
    let hasDryTerminal = false
    let hasUnknownSend = false
    const auxTargets = new Set<string>()
    const sumTargets = new Set<string>()

    for (const { text: line } of ownLines) {
      if (OUTPUT_CALL.test(line) || MASTER_ACCESS.test(line)) {
        hasDestination = true
        hasDryTerminal = true
      }

      // `matchAll` は species で regex を複製して複製側の lastIndex だけを進めるので、
      // `g` 付きの共有パターンを使い回しても状態は汚れない。
      for (const match of line.matchAll(SEND_CALL)) {
        hasDestination = true
        const target = match[1] ?? match[2]
        if (sumNames.has(target)) sumTargets.add(target)
        else if (auxNames.has(target)) auxTargets.add(target)
        else hasUnknownSend = true
      }

      for (const [target, pattern] of sumPatterns) {
        if (pattern.test(line)) {
          hasDestination = true
          hasDryTerminal = true
          sumTargets.add(target)
        }
      }
      for (const [target, pattern] of auxPatterns) {
        if (pattern.test(line)) {
          hasDestination = true
          hasDryTerminal = true
          auxTargets.add(target)
        }
      }
    }

    const code = !hasDestination
      ? 'output-missing'
      : !hasDryTerminal && auxTargets.size > 0 && sumTargets.size === 0 && !hasUnknownSend
        ? 'dry-not-routed'
        : undefined
    if (!code) continue

    for (const { index: lineIndex, text } of ownLines) {
      for (const match of text.matchAll(PLAY_CALL)) {
        const startCol = match.index ?? 0
        const aux = [...auxTargets][0]
        issues.push({
          code,
          sequenceName: name,
          line: lineIndex,
          startCol,
          endCol: startCol + match[0].length,
          message:
            code === 'output-missing'
              ? `Sequence '${name}' has no output — it will be silent. Add .output() to route it to master, or .output("<bus>") / .send("<aux>", db).`
              : `Sequence '${name}' only sends to aux '${aux}' — its dry signal is not routed. Add .output() after the send to keep the dry signal, or ignore if this is intended.`,
        })
      }
    }
  }
  return issues
}

/** Compatibility name for callers that only want LinkAudio-file missing-output issues. */
export function analyzeLinkAudioMissingOutput(text: string): DiagnosticIssue[] {
  const lines = text.split('\n')
  if (findFirstMatchingLine(lines, LINK_AUDIO_PATTERN) === -1) return []
  return analyzeMissingOutput(text).filter((issue) => issue.code === 'output-missing')
}

export function missingOutputQuickFixEdit(
  text: string,
  issue: OutputRoutingDiagnosticIssue,
): { line: number; insertText: string } {
  const sourceLine = text.split('\n')[issue.line] ?? ''
  const indent = /^\s*/.exec(sourceLine)?.[0] ?? ''
  return {
    line: issue.line,
    insertText: `\n${indent}${issue.sequenceName}.output()`,
  }
}
