/** §5 の判定の型と 1:1。`smoke`（評価が通っただけ）は件数をラチェットで減らす。 */
export type ObservationKind =
  | 'capture-rms'
  | 'capture-onset'
  | 'capture-pitch'
  | 'capture-bits'
  | 'log-text'
  | 'file'
  | 'smoke'

export interface CoverageEntry {
  /** DSL 語（`runtime.ts` の Set の要素）または構文 id（`DslSyntaxId`）。 */
  readonly surface: string
  /** gated spec の `it(` タイトルに実在する文字列（部分一致で照合する）。 */
  readonly scenario: string
  readonly observation: ObservationKind
  /** 仕様セクション ID（台帳 1・§9）。無い表面は明示的に null。 */
  readonly specSection: string | null
}

/**
 * DSL 表面から gated シナリオと観測方法への台帳。
 *
 * PR-E4 は既存 E2E を増やさずラチェットだけを置くため、台帳は空から開始する。
 * 新しい行は A-4 で実在シナリオに、A-5 で smoke baseline に照合される。
 */
export const DSL_COVERAGE_LEDGER: readonly CoverageEntry[] = []
