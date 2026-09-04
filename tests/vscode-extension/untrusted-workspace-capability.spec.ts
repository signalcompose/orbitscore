/**
 * #385 PR-S-T1 — untrusted workspace で拡張が activate されることを、マニフェストの宣言で保証する。
 *
 * 🔴 **この PR の成果物はマニフェストの 1 ブロックだけ**なので、それを検査するテストが無いと
 * 「誰も読まない宣言」になる（[[consumerless-code-is-unprotected]] の型）。
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
import * as fs from 'fs'
import * as path from 'path'

import { describe, expect, it } from 'vitest'

const MANIFEST_PATH = path.resolve(__dirname, '../../packages/vscode-extension/package.json')

interface UntrustedWorkspacesCapability {
  readonly supported?: unknown
  readonly description?: unknown
  readonly restrictedConfigurations?: unknown
}

function readCapability(): UntrustedWorkspacesCapability {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as {
    capabilities?: { untrustedWorkspaces?: UntrustedWorkspacesCapability }
  }
  const capability = manifest.capabilities?.untrustedWorkspaces
  expect(
    capability,
    '#385: capabilities.untrustedWorkspaces を宣言しないと、loose-file 起動で拡張が activate されず ' +
      '「何も起きない」ようにしか見えない',
  ).toBeDefined()
  return capability as UntrustedWorkspacesCapability
}

/** マニフェストが宣言する設定キーを全部集める（`restrictedConfigurations` の実在確認に使う）。 */
function declaredConfigurationKeys(): ReadonlySet<string> {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as {
    contributes?: { configuration?: { properties?: Record<string, unknown> } }
  }
  return new Set(Object.keys(manifest.contributes?.configuration?.properties ?? {}))
}

describe('#385 untrusted workspace capability', () => {
  it('supports untrusted workspaces so a loose-file launch activates the extension', () => {
    expect(
      readCapability().supported,
      '🔴 owner 裁定（656 §16 (1)）は `true`。"limited" は撤回済み、`false` は症状が直らない',
    ).toBe(true)
  })

  it('restricts exactly the settings that choose which executable runs', () => {
    const restricted = readCapability().restrictedConfigurations
    expect(Array.isArray(restricted), 'restrictedConfigurations は配列').toBe(true)
    expect(
      [...(restricted as string[])].sort(),
      '「workspace が値を決めると別の実行ファイルが動く」ものだけを入れる',
    ).toEqual(['orbitscore.engine', 'orbitscore.scsynthPath'])
  })

  /**
   * 🔴 `orbitscore.audioDevice` を入れると **gated E2E のハーネスが壊れる** —
   * harness は workspace の `.vscode/settings.json` に `orbitscore.audioDevice` を書く
   * （`docs/design/656-release-design.md` §3.2）。デバイス名は実行対象を選ばないので、
   * 基準からしても対象外である。
   */
  it('does not restrict settings that name a device, a port, or a colour', () => {
    const restricted = new Set((readCapability().restrictedConfigurations as string[]) ?? [])
    for (const key of [
      'orbitscore.audioDevice',
      'orbitscore.engineDebug',
      'orbitscore.mcpServer.port',
    ]) {
      expect(
        restricted.has(key),
        `${key} は実行対象を選ばないので restrict しない（audioDevice は gated harness が書く）`,
      ).toBe(false)
    }
  })

  it('only restricts settings this extension actually contributes', () => {
    const declared = declaredConfigurationKeys()
    for (const key of (readCapability().restrictedConfigurations as string[]) ?? []) {
      expect(declared.has(key), `${key} が contributes.configuration に無い（綴り間違い）`).toBe(
        true,
      )
    }
  })

  it('explains why evaluation is allowed, so the reason survives the next reader', () => {
    const description = readCapability().description
    expect(typeof description, 'description は文字列').toBe('string')
    // DAW と同じ挙動である、という裁定の根拠が読めること。
    expect(
      (description as string).toLowerCase(),
      '裁定の根拠（DAW と同じくプロジェクトのプラグインを読む）が description に無い',
    ).toContain('daw')
  })
})
