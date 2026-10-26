/**
 * パリティ台帳（`native-parity-ledger.ts`・設計 848 §1.2 D-1 / D-3）の検査。ゲートの外で毎回回る。
 *
 * - 未分類 0: gated suite の題名がすべて台帳に在り、台帳に余分な題名が無い
 * - 台帳の `needsEditor` / `app` が構文木の解析（`gated-suite-analysis.ts`）と一致する（分類を黙ってずらさない）
 * - 基準タグが手元にあれば、台帳の題名 = タグの時点の題名（母集団）。CI の浅い clone にはタグが無い
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { analyzeGatedSuite } from './helpers/gated-suite-analysis'
import {
  MAIN_PHASE_TITLE,
  PARITY_BASELINE_TAG,
  PARITY_LEDGER,
  paritySkipReason,
  type ParityEntry,
} from './native-parity-ledger'

const repoRoot = path.resolve(__dirname, '../..')
const SUITE = 'tests/e2e/orbitstudio-mcp-gated.spec.ts'
const helpersDir = path.join(__dirname, 'helpers')
const current = analyzeGatedSuite(fs.readFileSync(path.join(repoRoot, SUITE), 'utf8'), helpersDir)

function baselineSuite(): string | null {
  try {
    execFileSync('git', ['rev-parse', '--verify', '-q', `${PARITY_BASELINE_TAG}^{commit}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    })
  } catch {
    return null
  }
  return execFileSync('git', ['show', `${PARITY_BASELINE_TAG}:${SUITE}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}
const baseline = baselineSuite()

describe('native parity ledger (design 848 §1.2 D-1)', () => {
  it('reads a non-empty suite (the enumeration itself is not broken)', () => {
    expect(current.length).toBeGreaterThanOrEqual(56)
  })

  it('has no unclassified title and no stale entry', () => {
    const titles = current.map((test) => test.title)
    const ledger = PARITY_LEDGER.map((entry) => entry.title)
    expect(titles.filter((title) => !ledger.includes(title))).toEqual([])
    expect(ledger.filter((title) => !titles.includes(title))).toEqual([])
    expect(new Set(ledger).size).toBe(ledger.length)
  })

  it('gives every not-applicable a reason and every entry a basis', () => {
    for (const entry of PARITY_LEDGER) {
      expect(entry.basis.trim(), entry.title).not.toBe('')
      if (entry.parity === 'not-applicable') expect(entry.reason?.trim(), entry.title).toBeTruthy()
      else expect(entry.reason, entry.title).toBeUndefined()
    }
  })

  it.each(current.map((test) => [test.title, test] as const))(
    'needsEditor / app of %s match the suite',
    (title, test) => {
      const entry = PARITY_LEDGER.find((candidate) => candidate.title === title)
      expect(entry, title).toBeDefined()
      expect(
        { needsEditor: entry!.needsEditor, app: entry!.app },
        `editor tools: ${test.editorTools.join(', ') || '(none)'}`,
      ).toEqual({ needsEditor: test.editorTools.length > 0, app: test.ownApp ? 'own' : 'shared' })
    },
  )

  it('starts the suite with the main phase that the shared titles depend on', () => {
    expect(current[0]?.title).toBe(MAIN_PHASE_TITLE)
    expect(PARITY_LEDGER.find((entry) => entry.title === MAIN_PHASE_TITLE)?.app).toBe('own')
  })

  it.runIf(baseline !== null)(
    `lists exactly the titles of the baseline tag ${PARITY_BASELINE_TAG}`,
    () => {
      const titles = analyzeGatedSuite(baseline!, helpersDir).map((test) => test.title)
      expect(titles).toHaveLength(56)
      expect(PARITY_LEDGER.map((entry) => entry.title)).toEqual(titles)
    },
  )
})

describe('paritySkipReason (design 848 §10.2)', () => {
  const entry = (title: string, overrides: Partial<ParityEntry> = {}): ParityEntry => ({
    title,
    parity: 'native-required',
    basis: 'b',
    needsEditor: false,
    app: 'shared',
    ...overrides,
  })

  it('never skips on the vscode target', () => {
    for (const { title } of PARITY_LEDGER) expect(paritySkipReason(title, 'vscode')).toBeNull()
  })

  it('skips needs-editor titles on headless, and shared titles when the main phase is skipped', () => {
    const ledger = [
      entry(MAIN_PHASE_TITLE, { app: 'own', needsEditor: true }),
      entry('shared engine-only'),
      entry('own engine-only', { app: 'own' }),
      entry('own editor', { app: 'own', needsEditor: true }),
    ]
    expect(paritySkipReason(MAIN_PHASE_TITLE, 'headless', ledger)).toMatch(/^needs-editor/)
    expect(paritySkipReason('shared engine-only', 'headless', ledger)).toMatch(
      /^needs the main phase/,
    )
    expect(paritySkipReason('own engine-only', 'headless', ledger)).toBeNull()
    expect(paritySkipReason('own editor', 'headless', ledger)).toMatch(/^needs-editor/)
    // native はエディタを持つので、needs-editor でも走る。
    expect(paritySkipReason('own editor', 'native', ledger)).toBeNull()
    expect(paritySkipReason('shared engine-only', 'native', ledger)).toBeNull()
  })

  it('skips not-applicable titles with their reason on native and headless', () => {
    const ledger = [
      entry('vsix only', { parity: 'not-applicable', reason: 'checks the .vsix layout' }),
    ]
    expect(paritySkipReason('vsix only', 'native', ledger)).toBe(
      'not-applicable: checks the .vsix layout',
    )
    expect(paritySkipReason('vsix only', 'headless', ledger)).toBe(
      'not-applicable: checks the .vsix layout',
    )
  })

  it('leaves the D-3 set of v4.4.0 explicit (what headless still runs)', () => {
    const runs = PARITY_LEDGER.filter((e) => paritySkipReason(e.title, 'headless') === null).map(
      (e) => e.title,
    )
    // 先頭の題名がエディタを使い、共有の状態を作るので、headless で残るのは自前でアプリを
    // 起こしてエディタを使わない題名だけ（設計の曖昧さとして PR に記録した）。
    expect(runs).toEqual(['#779 startup sweep unlinks orphaned outproc shm but keeps live ones'])
  })
})
