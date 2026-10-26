/**
 * 鳴っている `play()` の出どころ（設計 997 §4.4 D-P1 / D-P2・#987・束 S-eval #1022 の N1-d4）。
 *
 * engine は `play()` のたびにシーケンスへ世代番号を振って `pattern` で知らせ、鳴った step にスケジュール
 * した時点の世代を付ける。層 2 は文を 1 つずつ実行している（D-U2）ので、ある文の実行中に届いた世代は
 * **その文のもの**と決まる。ここはその対応（`(seq, generation) → 文の範囲`）を覚え、step を受けた時に
 * `transport.step.source` を返す。鳴っているパターンが変わる（世代が変わる）まで source は前の文のまま。
 */
import type { Position, Range } from './document-store'

/** スキーマの `DocumentRange`（1.1）。 */
export interface DocumentRange {
  uri: string
  version: number
  range: Range
}

/** スキーマの `StepSource`: `play()` を含む文の範囲（要求の `code` の座標）と、写せた時は文書の座標。 */
export interface StepSource {
  evalId: string
  start: Position
  end: Position
  document?: DocumentRange
}

/**
 * 要求の `code` の行 i が始まる文書の位置（D-P2）。subject-block の `code` は文書の離れた行を繋いで
 * いるので、`target.range` の始点を足すだけでは戻らない。層 2 の中だけで持ち、wire には載せない。
 */
export interface CodeLineMap {
  uri: string
  version: number
  lines: readonly Position[]
}

/** `code` の範囲を文書の範囲へ写す。表の外の行を指す時は undefined。 */
export function toDocumentRange(map: CodeLineMap, range: Range): DocumentRange | undefined {
  const at = (position: Position): Position | undefined => {
    const lineStart = map.lines[position.line]
    if (!lineStart) return undefined
    return { line: lineStart.line, character: lineStart.character + position.character }
  }
  const start = at(range.start)
  const end = at(range.end)
  return start && end ? { uri: map.uri, version: map.version, range: { start, end } } : undefined
}

/**
 * 1 つのシーケンスについて覚えておく世代の数。`play()` の直前にスケジュール済みの step は前の世代で
 * 鳴るので、最新の 1 つだけでは足りない。
 */
const GENERATIONS_PER_SEQ = 8

export class StepSources {
  private readonly bySeq = new Map<string, Map<number, StepSource>>()

  remember(seq: string, generation: number, source: StepSource): void {
    let generations = this.bySeq.get(seq)
    if (!generations) {
      generations = new Map()
      this.bySeq.set(seq, generations)
    }
    generations.set(generation, source)
    if (generations.size > GENERATIONS_PER_SEQ) {
      const oldest = generations.keys().next().value
      if (oldest !== undefined) generations.delete(oldest)
    }
  }

  /** 覚えていない世代（MCP の評価・import 先の文・層 2 の外で置かれたパターン）の step は null。 */
  sourceOf(seq: string, generation: number | undefined): StepSource | null {
    if (generation === undefined) return null
    return this.bySeq.get(seq)?.get(generation) ?? null
  }
}
