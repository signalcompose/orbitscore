import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { countCodeLines } from './code-lines'
import { listMeasuredFiles } from './file-size-targets'

/**
 * ファイルサイズのラチェット（#888 子 0）。
 *
 * 🔴 これは #888 本文の裁定を**仕組みに変える**テストである（CLAUDE.md
 * 「規律を足す時は、同時にそれを守らせる仕組みを足すこと」）。裁定:
 *
 * - 閾値 = **コード行 500**（空行・コメント専用行・Rust のインライン
 *   `#[cfg(test)] mod` を数えない。数え方は `code-lines.ts` §3 を参照）
 * - baseline は既存3本（`worklog-size.spec.ts` / `dsl-e2e-coverage.spec.ts` /
 *   `planning-issue-state.spec.ts`）と同じ形の**ラチェット**: 現寸で登録し、
 *   **増やす編集は red・減らす編集は緑**
 *
 * ## このテストの契約
 *
 * baseline に載っているファイルは baseline の値を超えられず、載っていない
 * ファイルは 500 行を超えられない。**baseline の数字を増やして通すことは
 * できない**（このテストが直接は止めないが、後述のレビュー規則で止める）。
 *
 * - 新しいファイルを 500 行超まで太らせる、または既存ファイルが baseline
 *   値を超えて太る → **red**（分割する。baseline に足す/上げるのは禁止）
 * - baseline にあるファイルを分割して閾値以下に収めたら、そのエントリは
 *   **消してよい**（消さなくても緑のまま）
 * - baseline のエントリが古くなった（消えた・実際より緩い）ら **red**
 *   （honesty 検査。既存3本と同じ: `dsl-e2e-coverage` の "keeps the baseline
 *   honest"・`planning-issue-state` の "every baseline entry still exists"）
 *
 * ## レビューで見ること（仕組みでは止まらない部分）
 *
 * 🔴 **baseline の数字をソースと一緒に増やす編集**（ファイルを+10行太らせて
 * JSON も+10にする）は、既存3本と同様この仕組みでは止まらない。
 * `tests/repo/file-size-baseline.json` の diff に `+` が付いた行は「値が
 * 増えた」か「エントリが増えた」のどちらかしかないので、レビュアーは
 * baseline の diff を見るだけでよい（`BUNDLE_BRANCH_WORKFLOW.md` §5.1）。
 *
 * ## 対象範囲（意図的な除外）
 *
 * `tests/**` は測定対象に**含めない**（設計 §4.3）。含めると、実機 gated
 * spec に E2E を1本足しただけで red になり、CLAUDE.md「DSL を足したら
 * E2E も足す」と正面から衝突する。`tests/` 側の肥大は別の受け皿
 * （#668 PR-E1 の `gated-sources.ts` 分割）に任せる。
 */
const repoRoot = path.resolve(__dirname, '../..')
const BASELINE_PATH = path.join(__dirname, 'file-size-baseline.json')

interface Baseline {
  threshold: number
  files: Record<string, number>
}

function loadBaseline(): Baseline {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline
}

/** 対象ファイルごとの現在のコード行数。1ファイルでも throw したらそのまま失敗させる。 */
function measureAll(): Map<string, number> {
  const measured = new Map<string, number>()
  for (const file of listMeasuredFiles(repoRoot)) {
    const source = fs.readFileSync(path.join(repoRoot, file.path), 'utf8')
    let count
    try {
      count = countCodeLines(source, file.lang)
    } catch (e) {
      // 🔴 try/catch で握らない（§3.3）。ファイル名を付けて再送出するだけ。
      throw new Error(`${file.path}: ${(e as Error).message}`)
    }
    measured.set(file.path, count.code)
  }
  return measured
}

describe('file size ratchet (#888 child 0)', () => {
  it('does not let a file grow past the threshold or past its baseline (ratchet)', () => {
    const baseline = loadBaseline()
    const measured = measureAll()

    const violations: string[] = []
    for (const [filePath, code] of measured) {
      const allowed = baseline.files[filePath] ?? baseline.threshold
      if (code > allowed) {
        violations.push(`  ${filePath}: ${code} / allowed ${allowed}`)
      }
    }

    expect(
      violations,
      'ファイルが閾値、または baseline に登録された自分の値を超えました:\n' +
        violations.join('\n') +
        '\n\n分割してください。baseline に足す・値を上げる編集は禁止です（子0の裁定）。',
    ).toEqual([])
  })

  it('keeps the baseline honest (every entry is real, current, and above the threshold)', () => {
    const baseline = loadBaseline()
    const measured = measureAll()
    const measuredPaths = new Set(measured.keys())
    const problems: string[] = []

    if (baseline.threshold !== 500) {
      problems.push(`threshold は 500 で固定です（#888 裁定1）。現在の値: ${baseline.threshold}`)
    }

    for (const [filePath, baselineValue] of Object.entries(baseline.files)) {
      if (!measuredPaths.has(filePath)) {
        problems.push(
          `${filePath}: baseline にありますが、測定対象に存在しません` +
            '（消えた・改名した・測定対象外のパスに移った）。このエントリを消してください。',
        )
        continue
      }

      const actual = measured.get(filePath) as number

      if (baselineValue <= baseline.threshold) {
        problems.push(
          `${filePath}: baseline 値 ${baselineValue} が閾値 ${baseline.threshold} 以下です。` +
            'この行は意味を持たないので消してください。',
        )
        continue
      }

      if (baselineValue > actual) {
        problems.push(
          `${filePath}: baseline 値 ${baselineValue} が実際のコード行数 ${actual} より` +
            ` 大きいです（減ったのに baseline が古いまま）。次の値に下げてください:\n` +
            `    "${filePath}": ${actual},`,
        )
      }
    }

    expect(problems, 'baseline が現状と食い違っています:\n' + problems.join('\n')).toEqual([])
  })
})
