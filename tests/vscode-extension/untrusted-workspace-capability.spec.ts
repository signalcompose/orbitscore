/**
 * #385 PR-S-T1 — untrusted workspace で拡張が activate されることを、マニフェストの宣言で保証する。
 *
 * 🔴 **この層が検査するのはマニフェストの宣言だけ**である。「実際に untrusted workspace で
 * activate され、しかも普通に音が出る」ことは **gated E2E の `E2E-D1`** が実機で押さえる
 * （`tests/e2e/orbitstudio-mcp-gated.spec.ts`・設計 `656-release-design.md` §12）。
 * 宣言の検査だけで済ませると「誰も読まない宣言」になる（[[consumerless-code-is-unprotected]]）。
 *
 * ## 何が壊れていたか（#385）
 *
 * フォルダ無しの loose-file 起動（`orbs file.orbs` — ライブコーディングの典型動線）は
 * **未信頼の ad-hoc workspace** を作る。`capabilities.untrustedWorkspaces` を宣言していない拡張は
 * そこで**制限付き**になり **activate されない**。利用者には「何も起きない」ようにしか見えない。
 * 実害は拒否ではなく**沈黙**である。
 *
 * ## なぜ `true` か（owner 裁定 2026-09-03・`docs/design/656-release-design.md` §16 (1)）
 *
 * > 一般的な DAW の挙動に併せて。
 *
 * DAW はプロジェクトを開く時に信頼を問わずプラグインを読む。OrbitScore も untrusted workspace で
 * engine を起動し、譜面の `instrument(path)` を読む。`"limited"`（開けるが走らせるには信頼が要る）は
 * **撤回された**。`false` は今日の挙動（黙って何も起きない）を宣言するだけで症状が直らない。
 *
 * 🔴 **したがって `startEngine()` に trust ガードは置かない。** 裁定表が
 * 「B ならガードが不要になる」と明記している。ライブコーディングは評価を繰り返す行為なので、
 * 1 回の確認が「毎回の中断」になる（owner 2026-09-04）。
 *
 * ## `restrictedConfigurations` の基準
 *
 * 「**workspace が値を決めると別の実行ファイルが動く**」ものだけを入れる。これは
 * `supported` の値と独立に効く保護であり、**ワークフローには一切現れない**（評価も再生も止まらない）。
 */
import { describe, expect, it } from 'vitest'

import {
  declaredConfigurationKeys,
  readExtensionManifest,
} from '../helpers/vscode-extension-manifest'

const capability = readExtensionManifest().capabilities?.untrustedWorkspaces

/**
 * `restrictedConfigurations` を **string[] として取り出す**。
 *
 * 🔴 ここで `?? []` に落とさないのが load-bearing である。空配列へフォールバックすると、
 * 宣言が丸ごと消えた時に `for...of` が 0 周して**何も検査せず green** になる
 * （[[test-assertions-must-discriminate]]）。取り出せない形なら**ここで落とす**。
 */
function restrictedConfigurations(): readonly string[] {
  const restricted = capability?.restrictedConfigurations
  expect(
    Array.isArray(restricted),
    'restrictedConfigurations が配列でない（宣言が消えると以降の検査が素通りになるため、ここで止める）',
  ).toBe(true)
  return restricted as readonly string[]
}

describe('#385 untrusted workspace capability', () => {
  it('declares the untrustedWorkspaces capability at all', () => {
    expect(
      capability,
      '#385: capabilities.untrustedWorkspaces を宣言しないと、loose-file 起動で拡張が activate されず ' +
        '「何も起きない」ようにしか見えない',
    ).toBeDefined()
  })

  it('supports untrusted workspaces so a loose-file launch activates the extension', () => {
    expect(
      capability?.supported,
      '🔴 owner 裁定（656 §16 (1)）は `true`。"limited" は撤回済み、`false` は症状が直らない',
    ).toBe(true)
  })

  it('restricts exactly the settings that choose which executable runs', () => {
    expect(
      [...restrictedConfigurations()].sort(),
      '「workspace が値を決めると別の実行ファイルが動く」ものだけを入れる',
    ).toEqual(['orbitscore.engine', 'orbitscore.scsynthPath'])
  })

  /**
   * 🔴 `orbitscore.audioDevice` を入れると **gated E2E のハーネスが壊れる** —
   * harness は workspace の `.vscode/settings.json` に `orbitscore.audioDevice` を書く
   * （`docs/design/656-release-design.md` §3.2）。デバイス名は実行対象を選ばないので、
   * 基準からしても対象外である。
   *
   * `flash*` / `playheadPalette`（色）も同じ理由で対象外。**マニフェストが宣言する設定を
   * 全件走査**して、基準に合わないものが混ざっていないことを見る — 名指しの 3 件だけを
   * 否定すると、後から足された設定が漏れる（[[enumeration-stops-one-level-too-early]]）。
   */
  it('restricts nothing that merely names a device, a port, or a colour', () => {
    const restricted = new Set(restrictedConfigurations())
    const executableChoosing = new Set(['orbitscore.scsynthPath', 'orbitscore.engine'])
    const declared = [...declaredConfigurationKeys()]
    expect(declared.length, 'contributes.configuration が空なら走査が無意味になる').toBeGreaterThan(
      0,
    )
    for (const key of declared) {
      if (executableChoosing.has(key)) continue
      expect(
        restricted.has(key),
        `${key} は実行対象を選ばないので restrict しない（audioDevice は gated harness が書く）`,
      ).toBe(false)
    }
  })

  it('only restricts settings this extension actually contributes', () => {
    const declared = declaredConfigurationKeys()
    for (const key of restrictedConfigurations()) {
      expect(declared.has(key), `${key} が contributes.configuration に無い（綴り間違い）`).toBe(
        true,
      )
    }
  })

  it('explains why evaluation is allowed, so the reason survives the next reader', () => {
    const description = capability?.description
    expect(typeof description, 'description は文字列').toBe('string')
    // DAW と同じ挙動である、という裁定の根拠が読めること。
    expect(
      (description as string).toLowerCase(),
      '裁定の根拠（DAW と同じくプロジェクトのプラグインを読む）が description に無い',
    ).toContain('daw')
  })
})
