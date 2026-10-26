/**
 * 暫定物の台帳の検査（設計 848 §1.4.2・完了条件 D-11）。
 *
 * `npm test` で毎回、検査 1〜5 と 7 を実際のリポジトリに掛ける。検査 6（release モード）は
 * `ORBIT_RELEASE_PREFLIGHT=1` の時だけ実際のリポジトリに掛け、リリースの preflight
 * （`verify-app.sh`・束 R-app）がこのモードで呼ぶ — 足場（P-01 など）が残っているとリリースが落ちる。
 *
 * 後半は検査ごとに「その形を作ると red になる」ことを合成の入力で確かめる（何も見ていない検査を
 * 通さないため）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  designLedgerIds,
  LEDGER,
  ledgerViolations,
  scanMarkers,
  type LedgerEntry,
  type LedgerInput,
  type MarkerScan,
} from './native-provisional-ledger'

const repoRoot = path.resolve(__dirname, '../..')
const DESIGN = 'docs/design/848-native-orbitstudio-design.md'
const releaseMode = process.env.ORBIT_RELEASE_PREFLIGHT === '1'

function realInput(overrides: Partial<LedgerInput> = {}): LedgerInput {
  return {
    ledger: LEDGER,
    scan: scanMarkers(repoRoot),
    exists: (relative) => fs.existsSync(path.join(repoRoot, relative)),
    repoRoot,
    designIds: designLedgerIds(fs.readFileSync(path.join(repoRoot, DESIGN), 'utf8')),
    releaseMode: false,
    ...overrides,
  }
}

describe('native provisional ledger (design 848 §1.4)', () => {
  it('reads the ledger rows from design §1.4.1 (the table is not silently empty)', () => {
    const ids = designLedgerIds(fs.readFileSync(path.join(repoRoot, DESIGN), 'utf8'))
    expect(ids.length).toBeGreaterThanOrEqual(18)
    expect(ids).toContain('P-01')
  })

  it('finds the markers of the scaffolds that exist today', () => {
    const ids = scanMarkers(repoRoot).markers.map((marker) => marker.id)
    expect(ids).toContain('P-02')
    expect(ids).toContain('P-25')
    // P-01（評価の受付口の足場）と P-07（console の横取り）は束 S-eval（#1022）で閉じ、印も消えた
    expect(ids).not.toContain('P-01')
    expect(ids).not.toContain('P-07')
  })

  it('has no violation in the repository (checks 1–5 and 7)', () => {
    expect(ledgerViolations(realInput())).toEqual([])
  })

  it.runIf(releaseMode)('release preflight: every release-1 row is closed (check 6 · D-11)', () => {
    expect(ledgerViolations(realInput({ releaseMode: true }))).toEqual([])
  })
})

describe('native provisional ledger — each check goes red on its shape', () => {
  const entry = (overrides: Partial<LedgerEntry>): LedgerEntry => ({
    id: 'P-90',
    title: 'synthetic',
    deadline: { kind: 'release-1' },
    state: 'open',
    bundle: 'test',
    markerless: 'synthetic',
    ...overrides,
  })
  const marker = (id: string) => ({ id, file: 'packages/session/src/x.ts', line: 3 })
  const input = (
    ledger: LedgerEntry[],
    scan: Partial<MarkerScan> = {},
    overrides: Partial<LedgerInput> = {},
  ): LedgerInput => ({
    ledger,
    scan: { markers: [], malformed: [], ...scan },
    exists: () => true,
    repoRoot,
    designIds: ledger.map((row) => row.id),
    releaseMode: false,
    ...overrides,
  })
  const codes = (violations: string[]) => violations.map((line) => line.slice(0, 3))

  it('[1] a marker whose id is not in the ledger', () => {
    expect(codes(ledgerViolations(input([entry({})], { markers: [marker('P-91')] })))).toEqual([
      '[1]',
    ])
  })

  it('[1] a marker for a row that is still planned', () => {
    const violations = ledgerViolations(
      input([entry({ state: 'planned' })], { markers: [marker('P-90')] }),
    )
    expect(codes(violations)).toEqual(['[1]'])
  })

  it('[1] a malformed marker', () => {
    const violations = ledgerViolations(
      input([entry({})], { malformed: [{ id: 'PROVISIONAL(P-1)', file: 'a.ts', line: 1 }] }),
    )
    expect(codes(violations)).toEqual(['[1]'])
  })

  it('[2] a closed row whose marker is still in the code, or without closedBy', () => {
    const violations = ledgerViolations(
      input([entry({ state: 'closed', closedBy: '#1' })], { markers: [marker('P-90')] }),
    )
    expect(codes(violations)).toEqual(['[2]'])
    expect(codes(ledgerViolations(input([entry({ state: 'closed' })])))).toEqual(['[2]'])
  })

  it('[3] an open row with neither a marker nor a markerless reason', () => {
    expect(codes(ledgerViolations(input([entry({ markerless: undefined })])))).toEqual(['[3]'])
  })

  it('[4] a when-exists row whose path appeared while its check is false', () => {
    const row = entry({
      deadline: { kind: 'when-exists', path: 'apps/OrbitStudio/Package.swift' },
      check: () => ({ ok: false, reason: 'not yet' }),
    })
    expect(codes(ledgerViolations(input([row])))).toEqual(['[4]'])
    expect(ledgerViolations(input([row], {}, { exists: () => false }))).toEqual([])
  })

  it('[5] an ext-retire row still open after the extension is gone', () => {
    const row = entry({ deadline: { kind: 'ext-retire' } })
    expect(ledgerViolations(input([row]))).toEqual([])
    expect(
      codes(
        ledgerViolations(
          input([row], {}, { exists: (relative) => relative !== 'packages/vscode-extension' }),
        ),
      ),
    ).toEqual(['[5]'])
  })

  it('[6] release mode: a release-1 row that is open or planned, or still marked', () => {
    expect(codes(ledgerViolations(input([entry({})], {}, { releaseMode: true })))).toEqual(['[6]'])
    expect(
      codes(ledgerViolations(input([entry({ state: 'planned' })], {}, { releaseMode: true }))),
    ).toEqual(['[6]'])
    const closedButMarked = ledgerViolations(
      input(
        [entry({ state: 'closed', closedBy: '#1' })],
        { markers: [marker('P-90')] },
        {
          releaseMode: true,
        },
      ),
    )
    expect(codes(closedButMarked)).toEqual(['[2]', '[6]'])
    // release モードでなければ同じ open の行は緑
    expect(ledgerViolations(input([entry({})]))).toEqual([])
  })

  it('[6] on the real repository, release mode names every release-1 row that is not closed', () => {
    // 仕組みが生きていることの確認（今は P-08 などが開いているので、リリースの preflight は落ちる）。
    // 第 1 リリースの時に全部が閉じれば、期待する一覧は空になり、この it はそのまま緑で残る。
    const violations = ledgerViolations(realInput({ releaseMode: true }))
    const notClosed = LEDGER.filter(
      (row) => row.deadline.kind === 'release-1' && row.state !== 'closed',
    ).map((row) => row.id)
    expect(notClosed).toContain('P-08')
    for (const id of notClosed) {
      expect(violations.some((line) => line.startsWith('[6]') && line.includes(`${id} `))).toBe(
        true,
      )
    }
  })

  it('[7] a row in the design table but not in the ledger, and vice versa', () => {
    expect(codes(ledgerViolations(input([entry({})], {}, { designIds: [] })))).toEqual(['[7]'])
    expect(
      codes(ledgerViolations(input([entry({})], {}, { designIds: ['P-90', 'P-92'] }))),
    ).toEqual(['[7]'])
  })
})
