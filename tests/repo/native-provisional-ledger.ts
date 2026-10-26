/**
 * 暫定物の台帳（設計 848 §1.4・一方通行 N-15）。
 *
 * **暫定物** = 最終形でないまま**動く**もの（段階移行の足場・「v1 だけ」の関門・申し送りの後始末・
 * 暫定の消費者・置き値）。動いているので完了条件 D-1〜D-10 は緑のままになり、最終形へ移る理由が
 * 失われる。owner の条件（2026-10-26）:「段階を分けて移行する場合には、ちゃんと忘れずに最後まで
 * 移行をするように。こういうのって動いて安心して終わってしまうことがあるので。」
 *
 * 規則:
 * - コードに置く印は `PROVISIONAL(P-01)`（コメントの中。TS / Swift は `//`、シェルは `#`）。
 *   検査は文字列 `PROVISIONAL(` を唯一のアンカーにする（形を仮定した grep にしない）
 * - **新しい暫定物を作る PR は、同じ PR で台帳に行を足し、印を置く**（検査 1 が強制する）
 * - 行は消さない（`closed` にして残す）。件数のラチェットにはしない
 * - 本ファイルの行の集合は設計 §1.4.1 の表の `P-xx` の集合と一致させる（検査 7）
 *
 * 期限（`deadline`）の種類は設計 §1.4.1 の 4 種 + `none`:
 * - `release-1` — 第 1 リリース（🚪）までに閉じる。release モード（`ORBIT_RELEASE_PREFLIGHT=1`）で検査
 * - `when-exists` — そのパスが現れた時点で `check` が真でなければ red
 * - `ext-retire` — 拡張版の退役（`packages/vscode-extension/` が消える PR）で閉じる
 * - `external` — 外部の上流に依存し、機械では期限を切れない（理由を書く）
 * - `none` — 期限が上の 4 種に当たらない行。設計の表の「期限」欄を理由に写す（P-03「第 1 リリースの後」・
 *   P-11 / P-14「各リリース」は台帳の外の仕組みが強制し〔`enforcedBy`〕、P-15 は仕組みを置けない）
 */
import fs from 'node:fs'
import path from 'node:path'

export type LedgerId = `P-${string}`

export type Deadline =
  | { kind: 'release-1' }
  | { kind: 'when-exists'; path: string }
  | { kind: 'ext-retire' }
  | { kind: 'external'; reason: string }
  | { kind: 'none'; reason: string }

/** `planned` = まだコードに無い / `open` = コードに在る / `closed` = 最終形へ移った（または作られずに済んだ）。 */
export type LedgerState = 'planned' | 'open' | 'closed'

export interface CheckResult {
  ok: boolean
  reason: string
}

export interface LedgerEntry {
  id: LedgerId
  title: string
  deadline: Deadline
  state: LedgerState
  /** 閉じた PR（番号）。作られずに済んだ行は理由。 */
  closedBy?: string
  /** コードに印を置かない理由（`open` の行で印が無い時に必須）。 */
  markerless?: string
  /** 台帳の外の既存の仕組みが強制する行（台帳の spec はその行を検査しない）。 */
  enforcedBy?: string
  /** `when-exists` の行と、release モードで評価する検査。 */
  check?: (repoRoot: string) => CheckResult
  /** 担当の束（入る → 消える）。 */
  bundle: string
}

/** 印を走査する場所（設計 §1.4.2）。台帳のファイル自身は除く。 */
export const MARKER_SCAN_ROOTS = [
  'packages/session',
  'apps/OrbitStudio',
  'protocol',
  'scripts',
  'tests',
] as const

export const LEDGER_SELF_FILES = [
  'tests/repo/native-provisional-ledger.ts',
  'tests/repo/native-provisional-ledger.spec.ts',
] as const

const read = (repoRoot: string, relative: string): string | undefined => {
  const file = path.join(repoRoot, relative)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined
}

const hasFiles = (repoRoot: string, relative: string): boolean => {
  const dir = path.join(repoRoot, relative)
  return fs.existsSync(dir) && fs.readdirSync(dir).some((name) => !name.startsWith('.'))
}

export const LEDGER: readonly LedgerEntry[] = [
  {
    id: 'P-01',
    title: '評価の受付口の足場（凍結版の区切り方の写し・設計 §4.5.1 段階 1）',
    deadline: { kind: 'release-1' },
    state: 'open',
    bundle: 'S-rpc（N1-a0）→ S-eval',
  },
  {
    id: 'P-02',
    title: '凍結版 createReplSession との差分テスト（段階 1 = 一致 → 段階 2 = 違いの記録）',
    deadline: { kind: 'ext-retire' },
    state: 'open',
    bundle: 'S-rpc → S-eval → 退役',
  },
  {
    id: 'P-03',
    title: 'MCP ツールの v1 関門（名前・引数・戻り・tools/list の 28 本と順序）',
    deadline: {
      kind: 'none',
      reason: '第 1 リリースの後に外れる。切り替えは mcp-tools-v1.spec.ts が VERSION で自動で行う',
    },
    state: 'planned',
    enforcedBy: 'tests/protocol/mcp-tools-v1.spec.ts（S-mcp で新設・MCP_V1_GATE_UNTIL）',
    bundle: 'S-mcp',
  },
  {
    id: 'P-04',
    title:
      'WebView の playhead の暫定の消費者（transport.step の source が null の間の playhead.ts）',
    deadline: { kind: 'release-1' },
    state: 'planned',
    bundle: 'A-skeleton → S-eval',
  },
  {
    id: 'P-05',
    title: 'daemon が親の死を知らない間の後始末（#996 まで・残った daemon を PID で止める）',
    deadline: { kind: 'release-1' },
    state: 'planned',
    bundle: 'A-skeleton → engine 線（#996）',
  },
  {
    id: 'P-06',
    title: '楽器のノートの 5 ms ポーリング（T-1 = N0-d の判定の記録）',
    deadline: { kind: 'when-exists', path: 'apps/OrbitStudio/Package.swift' },
    state: 'open',
    markerless:
      '暫定物は packages/engine の midi-scheduler.ts（凍結版と共有のコード・走査の対象外）にあり、' +
      '期限が切るのは判定の記録（docs/research/848-timing-baseline.md）なので印を置かない',
    check: (repoRoot) => {
      const doc = read(repoRoot, 'docs/research/848-timing-baseline.md')
      const ok = doc !== undefined && /判定: (ゲート|ゲートにしない)/.test(doc)
      return {
        ok,
        reason: ok
          ? 'T-1 の判定の行がある'
          : 'docs/research/848-timing-baseline.md に「判定: ゲート」か「判定: ゲートにしない」の行が無い（N0-d）',
      }
    },
    bundle: 'N-spike（N0-d）→ engine 線 PR-Q',
  },
  {
    id: 'P-07',
    title: 'engine の console 出力を in-process で受け取る経路（console の横取り）',
    deadline: { kind: 'release-1' },
    state: 'open',
    bundle: 'S-rpc（N1-a2）→ S-eval',
  },
  {
    id: 'P-08',
    title: '実測で決める値（置き値）',
    deadline: { kind: 'release-1' },
    state: 'open',
    bundle: '各束（S-rpc / S-mcp / A-skeleton / A-parity / N-spike）',
  },
  {
    id: 'P-09',
    title: '拡張版と共存する間だけのもの（vscode ターゲット・パリティ台帳・release.yml ほか）',
    deadline: { kind: 'ext-retire' },
    state: 'open',
    markerless:
      'リポジトリの各所（release.yml・user サイトの拡張版の行・ハーネスの vscode ターゲット・' +
      '凍結版から写したモジュールの一覧 tests/session/frozen-copies.ts と、それを読む 2 つの spec）にあり、' +
      '退役の PR で packages/vscode-extension/ が消えた時に検査 5 が開いた行を red にする',
    bundle: '退役（時期は owner）',
  },
  {
    id: 'P-10',
    title: 'D-8 の follow-up（planning-issue-state.spec.ts の DOCUMENTS に新地図と新計画）',
    deadline: { kind: 'when-exists', path: 'packages/session/package.json' },
    state: 'closed',
    closedBy: '#1005（S-rpc の N1-a0）',
    check: (repoRoot) => {
      const spec = read(repoRoot, 'tests/docs/planning-issue-state.spec.ts') ?? ''
      const missing = [
        'docs/planning/NATIVE_DEVELOPMENT_MAP.md',
        'docs/planning/IMPLEMENTATION_PLAN_NATIVE.md',
      ].filter((doc) => !spec.includes(`'${doc}'`))
      return {
        ok: missing.length === 0,
        reason:
          missing.length === 0
            ? 'DOCUMENTS に 2 本が入っている'
            : `planning-issue-state.spec.ts の DOCUMENTS に無い: ${missing.join(', ')}`,
      }
    },
    bundle: 'S-rpc（N1-a0）',
  },
  {
    id: 'P-11',
    title: '同梱文書の「未リリース（<線>）」マーカー',
    deadline: { kind: 'none', reason: '各リリース（版番号が決まるまでの暫定値）' },
    state: 'planned',
    enforcedBy: 'verify-app.sh が check-availability.mjs --release を呼ぶ（別冊 §5.4・§6.4）',
    bundle: 'R-app / docs',
  },
  {
    id: 'P-12',
    title: 'docs 追従ルーチンの 09-18 の暫定行（手順の正本を DOCS_SYNC_ROUTINE.md へ写して撤回）',
    deadline: { kind: 'release-1' },
    state: 'planned',
    check: (repoRoot) => {
      const doc = read(repoRoot, 'docs/development/DOCS_SYNC_ROUTINE.md')
      if (doc === undefined) {
        return { ok: false, reason: 'docs/development/DOCS_SYNC_ROUTINE.md が無い' }
      }
      const left = ['追従対象外', 'OrbitStudio（凍結版'].filter((word) => doc.includes(word))
      return {
        ok: left.length === 0,
        reason:
          left.length === 0 ? '暫定行の語が 0 件' : `暫定行の語が残っている: ${left.join(', ')}`,
      }
    },
    bundle: 'docs の連続 PR ③',
  },
  {
    id: 'P-13',
    title: '(20) の owner の条件（拡張版の読者が OrbitStudio の記述を自分の手順として読まない）',
    deadline: { kind: 'when-exists', path: 'sites/user/scripts/check-availability.mjs' },
    state: 'planned',
    check: (repoRoot) => {
      const lint = read(repoRoot, 'sites/user/scripts/check-availability.mjs') ?? ''
      const ok = lint.includes('AV-HOST-SCOPE')
      return {
        ok,
        reason: ok
          ? '規則 AV-HOST-SCOPE がある'
          : 'check-availability.mjs に規則 AV-HOST-SCOPE が無い',
      }
    },
    bundle: 'docs の連続 PR ①',
  },
  {
    id: 'P-14',
    title: 'アプリの版の置き値 0.1.0-dev',
    deadline: { kind: 'none', reason: '各リリース（タグ = VERSION）' },
    state: 'planned',
    enforcedBy:
      'リリースの preflight が app-v<版> = VERSION を強制する（656 §4.4 の形・設計 §9.2 段 1）',
    bundle: 'R-app',
  },
  {
    id: 'P-15',
    title: '統合ブランチ名の 848- 仮置き（計画 §2.1）',
    deadline: {
      kind: 'none',
      reason:
        '仕組みを置けない（ブランチ名の hook は issue 番号の有無しか見ず、848 も番号なので通る）。' +
        '計画 §7 の作業列で各束の最初の手順を「束の issue を起票 → 計画 §2.1 を更新」にした',
    },
    state: 'open',
    markerless: '計画 §2.1 の表の中の文字列で、コードには無い',
    bundle: '各束の開始',
  },
  {
    id: 'P-16',
    title: '凍結版 4.4.0 の /mcp の Origin 未検証（#996 に記録）',
    deadline: { kind: 'ext-retire' },
    state: 'open',
    markerless:
      '凍結版のコード（packages/vscode-extension/src/mcp-server.ts）なので印を置かない。#996 が追跡する',
    bundle: '—',
  },
  {
    id: 'P-17',
    title: 'Monaco へのパッチ（N0-a で要ると決まった場合のみ）',
    deadline: {
      kind: 'external',
      reason:
        '上流の修正（microsoft/vscode#333909）の都合で期限を機械で切れない。' +
        'パッチの適用を Monaco の版に結びつけ、版を上げた時に当たらなければ build が落ちる形にする（N0-a）',
    },
    state: 'planned',
    bundle: 'N0-a → 上流',
  },
  {
    id: 'P-18',
    title: 'protocol:check が TS 側だけ（N0-b で生成ツールが決まるまで）',
    deadline: { kind: 'when-exists', path: 'apps/OrbitStudio/Package.swift' },
    state: 'open',
    check: (repoRoot) => {
      const ok = hasFiles(repoRoot, 'protocol/gen/swift')
      return {
        ok,
        reason: ok
          ? 'protocol/gen/swift/ に生成物がある'
          : 'protocol/gen/swift/ が空（N0-b の往復が未了）',
      }
    },
    bundle: 'S-rpc（N1-a1）→ N0-b',
  },
  {
    id: 'P-19',
    title:
      'スキーマにあって層 2 がまだ実装していないメソッド（METHOD_NOT_FOUND と「後の束で実装」の detail を返す）',
    deadline: { kind: 'release-1' },
    state: 'open',
    bundle: 'S-rpc（N1-a2）→ S-mcp / S-editor',
  },
  {
    id: 'P-20',
    title:
      'audio.selectDevice の選択を層 2 のメモリにだけ持つ（凍結版は設定に書いて次の起動へ持ち越した・持ち主が未決）',
    deadline: { kind: 'release-1' },
    state: 'open',
    bundle: 'S-mcp（N1-b1）→ A-panels（環境設定）',
  },
  {
    id: 'P-21',
    title:
      'docs の応答の CSP が置き値（script-src は VitePress のインラインスクリプトを見て N2 で決める）',
    deadline: { kind: 'release-1' },
    state: 'open',
    bundle: 'S-mcp（N1-b1）→ N2',
  },
  {
    id: 'P-22',
    title:
      '中継のスタブの置き場（~/Library/Application Support/OrbitStudio/bin/orbitstudio-mcp）が提案のまま（N0-c で決める）',
    deadline: { kind: 'release-1' },
    state: 'open',
    bundle: 'S-mcp（N1-b2）→ N0-c / N2',
  },
  {
    id: 'P-23',
    title:
      'ハーネスの native ターゲットが未実装（起動すると理由つきで失敗する・apps/OrbitStudio が要る）',
    deadline: { kind: 'when-exists', path: 'apps/OrbitStudio/Package.swift' },
    state: 'open',
    check: (repoRoot) => {
      const source = read(repoRoot, 'tests/e2e/orbitstudio-mcp-gated.spec.ts') ?? ''
      const ok = !source.includes('PROVISIONAL(P-23)')
      return {
        ok,
        reason: ok
          ? 'gated suite の native の分岐が足場でない'
          : 'apps/OrbitStudio があるのに、gated suite の native ターゲットがまだ「未実装」で落ちる',
      }
    },
    bundle: 'S-mcp（N1-b3）→ N2',
  },
]

// ---------------------------------------------------------------------------
// 検査（設計 §1.4.2）。spec は実際のリポジトリと、検査ごとに red になる合成の入力の両方で回す。
// ---------------------------------------------------------------------------

export interface Marker {
  id: string
  file: string
  line: number
}

export interface MarkerScan {
  markers: Marker[]
  /** `PROVISIONAL(` の後ろが `P-\d{2})` で閉じていない箇所（印の書き損じ）。 */
  malformed: Marker[]
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.build', '.vitepress', 'coverage'])
const MARKER_ANCHOR = 'PROVISIONAL('

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out)
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name))
    }
  }
}

/** 印を数える。文字列 `PROVISIONAL(` を唯一のアンカーにし、続く形を検査する。 */
export function scanMarkers(repoRoot: string): MarkerScan {
  const files: string[] = []
  for (const root of MARKER_SCAN_ROOTS) walk(path.join(repoRoot, root), files)
  const self = new Set(LEDGER_SELF_FILES.map((file) => path.join(repoRoot, file)))
  const scan: MarkerScan = { markers: [], malformed: [] }
  for (const file of files) {
    if (self.has(file)) continue
    const buffer = fs.readFileSync(file)
    if (buffer.includes(0)) continue // バイナリ
    const text = buffer.toString('utf8')
    if (!text.includes(MARKER_ANCHOR)) continue
    const relative = path.relative(repoRoot, file)
    text.split('\n').forEach((lineText, index) => {
      let at = lineText.indexOf(MARKER_ANCHOR)
      while (at !== -1) {
        const match = /^PROVISIONAL\((P-\d{2})\)/.exec(lineText.slice(at))
        const marker = {
          id: match?.[1] ?? lineText.slice(at, at + 20),
          file: relative,
          line: index + 1,
        }
        ;(match ? scan.markers : scan.malformed).push(marker)
        at = lineText.indexOf(MARKER_ANCHOR, at + MARKER_ANCHOR.length)
      }
    })
  }
  return scan
}

/** 設計 §1.4.1 の表の `P-xx`（検査 7 の相手）。 */
export function designLedgerIds(designText: string): string[] {
  const start = designText.indexOf('#### 1.4.1')
  const end = designText.indexOf('#### 1.4.2')
  if (start === -1 || end === -1) return []
  return [...designText.slice(start, end).matchAll(/^\| \*\*(P-\d{2})\*\* \|/gm)].map(
    (match) => match[1]!,
  )
}

export interface LedgerInput {
  ledger: readonly LedgerEntry[]
  scan: MarkerScan
  /** リポジトリの相対パスが在るか。 */
  exists: (relative: string) => boolean
  repoRoot: string
  designIds: readonly string[]
  releaseMode: boolean
}

/** 違反の一覧（空なら緑）。各行の先頭は検査の番号（設計 §1.4.2）。 */
export function ledgerViolations(input: LedgerInput): string[] {
  const { ledger, scan, exists, repoRoot, designIds, releaseMode } = input
  const violations: string[] = []
  const byId = new Map(ledger.map((entry) => [entry.id as string, entry]))
  const markersOf = (id: string) => scan.markers.filter((marker) => marker.id === id)
  const where = (marker: Marker) => `${marker.file}:${marker.line}`

  for (const marker of scan.malformed) {
    violations.push(`[1] 印の形が違う（PROVISIONAL(P-NN) で閉じる）: ${where(marker)} ${marker.id}`)
  }
  // 1. 印の ID はすべて台帳に在り、その行は planned でない
  for (const marker of scan.markers) {
    const entry = byId.get(marker.id)
    if (!entry) {
      violations.push(`[1] 台帳に無い暫定物の印: ${marker.id} at ${where(marker)}`)
    } else if (entry.state === 'planned') {
      violations.push(
        `[1] 印があるのに台帳の行が planned のまま（open にする）: ${marker.id} at ${where(marker)}`,
      )
    }
  }
  for (const entry of ledger) {
    // 台帳の外の既存の仕組みが強制する行（P-03 / P-11 / P-14）は二重に検査しない。
    if (entry.enforcedBy) continue
    const markers = markersOf(entry.id)
    // 2. closed の行の印は 0 件
    if (entry.state === 'closed' && markers.length > 0) {
      violations.push(
        `[2] 閉じた行の印が残っている: ${entry.id} at ${markers.map(where).join(', ')}`,
      )
    }
    if (entry.state === 'closed' && !entry.closedBy) {
      violations.push(`[2] 閉じた行に closedBy（PR か理由）が無い: ${entry.id}`)
    }
    // 3. open の行は印が 1 つ以上あるか、印を置かない理由を持つ
    if (entry.state === 'open' && markers.length === 0 && !entry.markerless) {
      violations.push(`[3] open の行に印も markerless の理由も無い: ${entry.id}`)
    }
    // 4. when-exists: パスが在るのに check が偽
    if (entry.deadline.kind === 'when-exists' && exists(entry.deadline.path)) {
      const result = entry.check?.(repoRoot) ?? {
        ok: false,
        reason: 'when-exists の行に check が無い',
      }
      if (!result.ok) {
        violations.push(
          `[4] ${entry.deadline.path} が在るのに満たしていない: ${entry.id} — ${result.reason}`,
        )
      }
    }
    // 5. ext-retire: 拡張版が無いのに open
    if (
      entry.deadline.kind === 'ext-retire' &&
      entry.state !== 'closed' &&
      !exists('packages/vscode-extension')
    ) {
      violations.push(`[5] 拡張版が退役したのに閉じていない: ${entry.id}`)
    }
    // 6. release モード: release-1 の行はすべて closed（check があれば真）、印は 0 件
    if (releaseMode && entry.deadline.kind === 'release-1') {
      if (entry.state !== 'closed') {
        violations.push(
          `[6] 第 1 リリースまでに閉じる行が ${entry.state}: ${entry.id} ${entry.title}`,
        )
      }
      if (markers.length > 0) {
        violations.push(
          `[6] 第 1 リリースまでに消す印が残っている: ${entry.id} at ${markers.map(where).join(', ')}`,
        )
      }
      const result = entry.check?.(repoRoot)
      if (result && !result.ok) {
        violations.push(`[6] ${entry.id} の検査が偽: ${result.reason}`)
      }
    }
  }
  // 7. 設計 §1.4.1 の表と台帳の行の集合が一致する
  const ids = new Set(ledger.map((entry) => entry.id as string))
  const documented = new Set(designIds)
  for (const id of documented) {
    if (!ids.has(id)) violations.push(`[7] 設計 §1.4.1 にあるのに台帳に無い: ${id}`)
  }
  for (const id of ids) {
    if (!documented.has(id)) violations.push(`[7] 台帳にあるのに設計 §1.4.1 に無い: ${id}`)
  }
  return violations
}
