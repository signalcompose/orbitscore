import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * 計画文書が「閉じた issue を未完了として語る」ことを**仕組みで**止める（#814）。
 *
 * 🔴 発端（2026-09-08）: 束 O-wire を閉じる直前、owner に「地図・設計・プランに反映してあるか」と
 * 問われて確認したところ、**地図の #801 行が「実測は負荷依存」のままだった**。これは**同日の実測で
 * 否定された記述**である（効く変数は `--test-threads`・除外実験で犯人は 1 本と確定）。
 *
 * **地図は次のセッションが最初に読む層**なので、古い記述は**申し送りの誤りを再生産する**。
 * 実際その束は、旧 `/goal` の「負荷をかけて再現条件を作る」という誤った前提から始まっていた。
 *
 * CLAUDE.md の「規律を足す時は、同時にそれを守らせる仕組みを足すこと」に従う。
 *
 * ## 🔴 このテストが捕まえないもの（過大評価しないこと）
 *
 * | 誤りの型 | 例 | 捕まるか |
 * |---|---|---|
 * | 状態語の矛盾 | CLOSED なのに「未着手」 | ✅ |
 * | **内容の誤り** | 「#801 は負荷依存」（issue は OPEN のまま）| ❌ **捕まらない** |
 * | 文書間のずれ | 地図は「PR-O3」・計画は「PR-O3a」 | ❌ |
 *
 * **今日いちばん危なかったのは 2 番目**である。そこは「実測を書くときは出典（日付・PR）を
 * 必須にする」という運用（`BUNDLE_BRANCH_WORKFLOW.md` §4）で、**後から反証できる形**にしておく。
 *
 * ## 判定の作法
 *
 * - **行の主題**＝その行に最初に現れる `#NNN`。同じ行に引用として出てくる別 issue は主題にしない
 *   （粗く全部見ると 18 件出るが、主題で絞ると 4 件だった・2026-09-08 実測）
 * - issue の状態は `docs/planning/issue-states.json`（`scripts/docs/refresh-issue-states.mjs` が生成）。
 *   🔴 **テストは GitHub API を叩かない** — ネットワークとレート制限がテストの赤の原因になると、
 *   #801 と同じ「赤の帰属ができない」状態を持ち込む
 * - **ベースラインはラチェット**: 既知の行は許容し、**増える方向の編集だけを red にする**
 *   （`dsl-e2e-coverage.spec.ts` と同じ形）
 */
const repoRoot = path.resolve(__dirname, '../..')

const DOCUMENTS = [
  'docs/planning/DEVELOPMENT_MAP.md',
  'docs/planning/IMPLEMENTATION_PLAN_2026-09.md',
  // #848 ネイティブ版の計画と地図。拡張版の 2 本と同じラチェットに載せる — 計画文書が
  // 閉じた issue を「未着手」と語る型のドリフトは、文書が増えるほど起きやすい。
  'docs/planning/IMPLEMENTATION_PLAN_NATIVE.md',
  'docs/planning/NATIVE_DEVELOPMENT_MAP.md',
] as const

/** 「まだ終わっていない」ことを含意する語。閉じた issue の行に出たら疑わしい。 */
const PENDING_WORDS = [
  '未着手',
  '未実装',
  '引き込む',
  '着手する',
  '着手可',
  '予定',
  '必要がある',
] as const

/**
 * 既知の未処理行（2026-09-08 時点）。**減らす方向にしか編集してはいけない。**
 *
 * 増やす編集は「閉じた issue を未完了として書いた」ことなので、レビューで止める。
 * 棚卸しそのものは別作業（`PROJECT_RULES.md` §1c の作法に従う）。
 */
const KNOWN_STALE_BASELINE: readonly string[] = [
  // --- 本当に古い記述（棚卸しで直す。PROJECT_RULES §1c の作法に従う）---
  'docs/planning/DEVELOPMENT_MAP.md:#739', // 「未着手・PR-O2 の直前に入れる」だが #739 は CLOSED
  'docs/planning/DEVELOPMENT_MAP.md:#649', // 「§10.1 は … 必要がある」だが doc 611 へ移管済み
  'docs/planning/DEVELOPMENT_MAP.md:#645', // 「#643 PR-3 と同じ PR 予定」だが #645 は CLOSED

  // --- 🔴 誤検知（主題の判定が届かない形）。消さずに理由を残す ---
  // 行頭の番号が「その行の主題」ではなく、未完了の語は**別の OPEN な issue**を指している。
  // 主題の判定を賢くするより、少数の誤検知を明示的に許容するほうが読みやすいと判断した。
  'docs/planning/IMPLEMENTATION_PLAN_2026-09.md:#761', // #761 の説明文。「着手可」は別の話題
  'docs/planning/IMPLEMENTATION_PLAN_2026-09.md:#773', // 「#757 に着手する時点で」= OPEN な #757 の話
  'docs/planning/IMPLEMENTATION_PLAN_2026-09.md:#668', // 主題は PR-E5（未着手）。#668 は文脈参照
]

interface StaleLine {
  key: string
  file: string
  line: number
  subject: number
  words: string[]
  text: string
}

function loadClosedIssues(): Set<number> {
  const raw = fs.readFileSync(path.join(repoRoot, 'docs/planning/issue-states.json'), 'utf8')
  return new Set<number>((JSON.parse(raw) as { closed: number[] }).closed)
}

function findStaleLines(closed: Set<number>): StaleLine[] {
  const found: StaleLine[] = []
  for (const file of DOCUMENTS) {
    const lines = fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n')
    lines.forEach((text, index) => {
      // 行の主題 = 最初に現れる issue 番号。引用として並ぶ他の番号は見ない。
      const subject = text.match(/#(\d{3,})/)
      if (!subject) return
      const number = Number(subject[1])
      if (!closed.has(number)) return
      const words = PENDING_WORDS.filter((word) => text.includes(word))
      if (words.length === 0) return
      found.push({
        key: `${file}:#${number}`,
        file,
        line: index + 1,
        subject: number,
        words: [...words],
        text: text.trim().slice(0, 120),
      })
    })
  }
  return found
}

describe('planning documents vs. issue state (#814)', () => {
  it('has an issue-state snapshot to compare against', () => {
    const snapshot = path.join(repoRoot, 'docs/planning/issue-states.json')
    expect(
      fs.existsSync(snapshot),
      `${snapshot} が無い。scripts/docs/refresh-issue-states.mjs で生成する`,
    ).toBe(true)
    expect(loadClosedIssues().size).toBeGreaterThan(0)
  })

  it('does not describe a closed issue as still pending (ratchet)', () => {
    const stale = findStaleLines(loadClosedIssues())
    const baseline = new Set(KNOWN_STALE_BASELINE)
    const added = stale.filter((entry) => !baseline.has(entry.key))

    expect(
      added.map(
        (entry) =>
          `${entry.file}:${entry.line} #${entry.subject} [${entry.words.join(',')}]\n    ${entry.text}`,
      ),
      '閉じた issue を「未完了」の語で書いている行が増えました。\n' +
        '🔴 ベースラインを増やして通すのではなく、記述を現状に合わせてください。\n' +
        '（地図は次のセッションが最初に読む層なので、古い記述は申し送りの誤りを再生産します）',
    ).toEqual([])
  })

  it('keeps the baseline honest: every baseline entry still exists', () => {
    // 直したのに baseline に残っていると、次に同じ行が腐っても検出できない。
    const stale = new Set(findStaleLines(loadClosedIssues()).map((entry) => entry.key))
    const resolved = KNOWN_STALE_BASELINE.filter((key) => !stale.has(key))
    expect(
      resolved,
      'baseline にあるのに実際は解消済みの項目です。KNOWN_STALE_BASELINE から削ってください。',
    ).toEqual([])
  })
})
