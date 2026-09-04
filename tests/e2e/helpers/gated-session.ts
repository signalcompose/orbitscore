/**
 * gated E2E のセッション（起動・tmpRoot・fixture・cleanup、#668 設計 §4.1）。
 *
 * `orbitstudio-mcp-gated.spec.ts` の `requireCatalogFixtures()` は suite ローカルの
 * closure（実 OrbitStudio.app を起動し、カタログを rescan した結果を保持する）で、
 * export できない。ここでは戻り値の**形**だけを型として持つ — 実際にセッションを
 * 組み立てる配線は、既存 20 本のシナリオを書き換えない本 PR のスコープ外（将来 PR）。
 */
import * as path from 'path'

import type { McpClient } from './mcp-client'

/** 実 fixture カタログ（4 プラグイン × path/name）。`requireCatalogFixtures()` の戻り値と同型。 */
export interface GatedCatalog {
  readonly clapSynthPath: string
  readonly clapEffectPath: string
  readonly vst3SynthPath: string
  readonly vst3EffectPath: string
  readonly clapSynthName: string
  readonly clapEffectName: string
  readonly vst3SynthName: string
  readonly vst3EffectName: string
}

/** 1 回の gated 実行のセッション（起動済み extension host + 隔離ルート + カタログ）。 */
export interface GatedSession {
  readonly client: McpClient
  /** 実行ごとの隔離ルート。workspace であり、afterAll で消える。 */
  readonly tmpRoot: string
  readonly catalog: GatedCatalog
  /** 落ちた時に WAV を残す先。`ORBIT_KEEP_CAPTURES` があればそこ、無ければ tmpRoot。 */
  captureWavPath(slug: string): string
}

/**
 * capture WAV の書き出し先を決める（#633）。`ORBIT_KEEP_CAPTURES=<dir>` が設定されていれば
 * そこへ、無ければ `tmpRoot` へ書く。
 *
 * 🔴 これが本モジュールでいちばん実害を消す。`tmpRoot` は `afterAll` で削除されるので、
 * `ORBIT_KEEP_CAPTURES` 未設定のまま落ちると証拠の WAV も一緒に消える。設定するとそこだけは
 * 掃除対象から外れ、落ちた後も聴ける/測れる（2026-08-29: master gain が instrument へ効いて
 * いない欠陥を捕まえたのは、この WAV を残して RMS を時系列で見たから）。
 *
 * 受け入れ条件（#668 発注 PR-E2）: `ORBIT_KEEP_CAPTURES` が未設定なら、解決されるパスは
 * 呼び出し元が以前組んでいたパスと同一であること（`path.join(tmpRoot, \`${slug}.wav\`)`）。
 */
export function captureWavPath(tmpRoot: string, slug: string): string {
  const dir =
    process.env.ORBIT_KEEP_CAPTURES !== undefined ? process.env.ORBIT_KEEP_CAPTURES : tmpRoot
  return path.join(dir, `${slug}.wav`)
}

/** `GatedSession` を client / tmpRoot / catalog から組み立てる薄いファクトリ。 */
export function createGatedSession(
  client: McpClient,
  tmpRoot: string,
  catalog: GatedCatalog,
): GatedSession {
  return {
    client,
    tmpRoot,
    catalog,
    captureWavPath: (slug: string) => captureWavPath(tmpRoot, slug),
  }
}
