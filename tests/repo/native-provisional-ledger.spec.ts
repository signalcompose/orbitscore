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
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

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
const releasePreflightValue = process.env.ORBIT_RELEASE_PREFLIGHT
if (
  releasePreflightValue !== undefined &&
  releasePreflightValue !== '' &&
  releasePreflightValue !== '1'
) {
  throw new Error(
    `ORBIT_RELEASE_PREFLIGHT must be "1" when set; got ${JSON.stringify(releasePreflightValue)}`,
  )
}
const releaseMode = releasePreflightValue === '1'
const temporaryRepositories: string[] = []

afterEach(() => {
  for (const temporaryRepository of temporaryRepositories.splice(0)) {
    fs.rmSync(temporaryRepository, { recursive: true, force: true })
  }
})

function temporaryRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-ledger-'))
  temporaryRepositories.push(root)
  return root
}

function writeFixture(root: string, relative: string, contents: string | Buffer): void {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

function ledgerRow(id: LedgerEntry['id']): LedgerEntry {
  const row = LEDGER.find((candidate) => candidate.id === id)
  if (!row) throw new Error(`missing ledger row in test: ${id}`)
  return row
}

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

  it('scans at least one existing root and reads files in the real repository', () => {
    const scan = scanMarkers(repoRoot)
    expect(scan.rootsScanned.length).toBeGreaterThan(0)
    expect(scan.filesRead).toBeGreaterThan(0)
  })

  it('has no violation in the repository (checks 1–5 and 7)', () => {
    expect(ledgerViolations(realInput())).toEqual([])
  })

  it.runIf(releaseMode)('release preflight: every release-1 row is closed (check 6 · D-11)', () => {
    expect(ledgerViolations(realInput({ releaseMode: true }))).toEqual([])
  })
})

describe('scanMarkers fixtures', () => {
  it('finds valid, malformed, mid-line and repeated markers while honoring exclusions', () => {
    const root = temporaryRepository()
    writeFixture(
      root,
      'packages/session/src/markers.ts',
      [
        '// PROVISIONAL(P-01)',
        'const middle = true // PROVISIONAL(P-02)',
        '// PROVISIONAL(P-03) and PROVISIONAL(P-04)',
        '// PROVISIONAL(P-1)',
      ].join('\n'),
    )
    writeFixture(root, 'packages/session/node_modules/ignored.ts', '// PROVISIONAL(P-90)')
    writeFixture(
      root,
      'scripts/binary.bin',
      Buffer.concat([Buffer.from([0]), Buffer.from('PROVISIONAL(P-88)')]),
    )
    writeFixture(root, 'tests/repo/native-provisional-ledger.ts', '// PROVISIONAL(P-91)')
    writeFixture(root, 'tests/repo/native-provisional-ledger.spec.ts', '// PROVISIONAL(P-92)')

    const scan = scanMarkers(root)
    expect(scan.markers.map(({ id, line }) => [id, line])).toEqual([
      ['P-01', 1],
      ['P-02', 2],
      ['P-03', 3],
      ['P-04', 3],
    ])
    expect(scan.malformed).toEqual([
      { id: 'PROVISIONAL(P-1)', file: 'packages/session/src/markers.ts', line: 4 },
    ])
    expect(scan.rootsScanned).toEqual(['packages/session', 'scripts', 'tests'])
    expect(scan.filesRead).toBe(2)
  })

  it('fails when none of the scan roots exists', () => {
    expect(() => scanMarkers(temporaryRepository())).toThrow('none of the marker scan roots exist')
  })

  it('fails instead of silently skipping a symbolic link', () => {
    const root = temporaryRepository()
    writeFixture(root, 'packages/session/src/target.ts', 'export {}')
    fs.symlinkSync(
      path.join(root, 'packages/session/src/target.ts'),
      path.join(root, 'packages/session/src/link.ts'),
    )
    expect(() => scanMarkers(root)).toThrow('does not follow symbolic links')
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
    scan: { markers: [], malformed: [], rootsScanned: [], filesRead: 0, ...scan },
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
    expect(
      ledgerViolations(
        input(
          [entry({ deadline: { kind: 'ext-retire' }, state: 'closed', closedBy: '#1' })],
          {},
          { exists: (relative) => relative !== 'packages/vscode-extension' },
        ),
      ),
    ).toEqual([])
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

  it('[6] release mode rejects a closed row whose check is false', () => {
    const row = entry({
      state: 'closed',
      closedBy: '#1',
      check: () => ({ ok: false, reason: 'scaffold still exists' }),
    })
    expect(codes(ledgerViolations(input([row], {}, { releaseMode: true })))).toEqual(['[6]'])
  })

  it('[6] on the real repository, release mode names every release-1 row that is not closed', () => {
    // 仕組みが生きていることの確認（今は足場 P-01 などが開いているので、リリースの preflight は落ちる）。
    // 第 1 リリースの時に全部が閉じれば、期待する一覧は空になり、この it はそのまま緑で残る。
    const violations = ledgerViolations(realInput({ releaseMode: true }))
    const notClosed = LEDGER.filter(
      (row) => row.deadline.kind === 'release-1' && row.state !== 'closed',
    ).map((row) => row.id)
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

  it('does not allow enforcedBy on a release-1 row', () => {
    const row = entry({ enforcedBy: 'tests/gate.ts' })
    expect(codes(ledgerViolations(input([row], {}, { exists: () => false })))).toEqual(['[6]'])
  })

  it('requires an existing enforcedBy path to name its ledger ID', () => {
    const root = temporaryRepository()
    const row = entry({
      deadline: { kind: 'none', reason: 'synthetic' },
      enforcedBy: 'tests/gate.ts',
    })
    writeFixture(root, 'tests/gate.ts', '// some other gate')
    const overrides = {
      repoRoot: root,
      exists: (relative: string) => fs.existsSync(path.join(root, relative)),
    }
    expect(codes(ledgerViolations(input([row], {}, overrides)))).toEqual(['[1]'])
    writeFixture(root, 'tests/gate.ts', '// gate for P-90')
    expect(ledgerViolations(input([row], {}, overrides))).toEqual([])
  })
})

describe('ledger row checks against fixture repositories', () => {
  it('P-01 closes only after the evaluation intake scaffold disappears', () => {
    const root = temporaryRepository()
    const check = ledgerRow('P-01').check!
    expect(check(root).ok).toBe(true)
    writeFixture(root, 'packages/session/src/eval/evaluation-intake.ts', 'export {}')
    expect(check(root)).toMatchObject({ ok: false })
  })

  it('P-06 accepts only a complete decision line at the end of a line', () => {
    const root = temporaryRepository()
    const check = ledgerRow('P-06').check!
    expect(check(root).ok).toBe(false)
    writeFixture(root, 'docs/research/848-timing-baseline.md', '判定: ゲートではない')
    expect(check(root).ok).toBe(false)
    writeFixture(root, 'docs/research/848-timing-baseline.md', '測定\n判定: ゲートにしない  \n')
    expect(check(root).ok).toBe(true)
  })

  it('P-12 requires the canonical document and rejects either provisional phrase', () => {
    const root = temporaryRepository()
    const check = ledgerRow('P-12').check!
    expect(check(root).ok).toBe(false)
    writeFixture(root, 'docs/development/DOCS_SYNC_ROUTINE.md', '追従対象外')
    expect(check(root).ok).toBe(false)
    writeFixture(root, 'docs/development/DOCS_SYNC_ROUTINE.md', '現在の同期手順')
    expect(check(root).ok).toBe(true)
  })

  it('P-18 rejects a file path, an empty directory and README-only placeholders', () => {
    const root = temporaryRepository()
    const check = ledgerRow('P-18').check!
    writeFixture(root, 'protocol/gen/swift', 'not a directory')
    expect(() => check(root)).not.toThrow()
    expect(check(root).ok).toBe(false)
    fs.rmSync(path.join(root, 'protocol/gen/swift'))
    fs.mkdirSync(path.join(root, 'protocol/gen/swift'), { recursive: true })
    expect(check(root).ok).toBe(false)
    writeFixture(root, 'protocol/gen/swift/README.md', 'placeholder')
    expect(check(root).ok).toBe(false)
    writeFixture(root, 'protocol/gen/swift/Session.swift', 'struct Session {}')
    expect(check(root).ok).toBe(true)
  })
})
