/**
 * MCP を通らない経路 — CLI（`orbitscore replay` / `render`、#668 設計 §4.5）。
 *
 * 原則の例外はここだけ: CLI は MCP tool を持たないが、ユーザーが実際に叩く動線なので
 * E2E は子プロセスで叩く（doc 694 §9 E2E-R1 / doc 598 §12 E2E-R5・R6）。
 *
 * 🔴 設計上の制約: CLI は自分で daemon を起動する。**MCP 側の engine を止めてから**
 * 呼ぶこと（daemon 本数の不変条件・#624 の二重出力事故と同じ理由）。
 * `ORBIT_CAPTURE_WAV` は CLI 側の env（`opts.env`）で渡す。
 */
import { spawnSync } from 'child_process'
import * as path from 'path'

const REPO_ROOT = path.resolve(__dirname, '../../..')
const CLI_ENTRY = path.join(REPO_ROOT, 'packages/engine/dist/cli-audio.js')

export interface CliResult {
  /** 🔴 0 以外を握り潰さない（#694 E2E-R3 は status ≠ 0 が判定）。 */
  readonly status: number
  readonly stdout: string
  /** 🔴 **成功時も回収する**（下の実装コメント参照）。 */
  readonly stderr: string
  /** タイムアウト等で殺された時のシグナル。正常終了なら null。 */
  readonly signal: NodeJS.Signals | null
  readonly durationMs: number
}

/**
 * `node <repoRoot>/packages/engine/dist/cli-audio.js <...args>` を子プロセスで実行する。
 *
 * bin 名は `orbitscore`（packages/engine/package.json の `bin`）だが、E2E は **dist を
 * 直接**叩く — グローバルインストールに依存しないため。`pretest:e2e:gated`
 * （package.json の該当スクリプト）が dist の鮮度を保証する。
 *
 * 🔴 **`execFileSync` ではなく `spawnSync` を使う**（silent-failure レビュー 2026-09-04）。
 * `execFileSync` は**成功時に stdout の文字列しか返さない**ので、子プロセスが stderr に
 * 何を書いても呼び出し元からは**原理的に見えない**。`stderr: ''` は「何も出なかった」ではなく
 * 「**出ても見えない**」を意味していた。exit 0 のまま警告だけ stderr に出す CLI の検証が
 * 書けなくなる。
 *
 * 🔴 **`signal` も返す。** タイムアウトで殺された（`SIGTERM`）のと、CLI が非ゼロで
 * 終了したのとは**別の失敗**であり、呼び出し側が区別できないと原因調査が空回りする。
 */
export function runOrbitscoreCli(
  args: readonly string[],
  opts?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
): CliResult {
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: opts?.cwd ?? REPO_ROOT,
    env: opts?.env ?? process.env,
    timeout: opts?.timeoutMs ?? 30_000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    // spawn 自体に失敗した場合（`result.error`）も status は null になるので -1 に寄せる。
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signal: result.signal ?? null,
    durationMs: Date.now() - startedAt,
  }
}
