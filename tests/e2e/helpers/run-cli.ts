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
import { execFileSync } from 'child_process'
import * as path from 'path'

const REPO_ROOT = path.resolve(__dirname, '../../..')
const CLI_ENTRY = path.join(REPO_ROOT, 'packages/engine/dist/cli-audio.js')

export interface CliResult {
  /** 🔴 0 以外を握り潰さない（#694 E2E-R3 は status ≠ 0 が判定）。 */
  readonly status: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

interface ExecFileSyncError {
  readonly status?: number | null
  readonly signal?: string | null
  readonly stdout?: string
  readonly stderr?: string
}

/**
 * `node <repoRoot>/packages/engine/dist/cli-audio.js <...args>` を子プロセスで実行する。
 *
 * bin 名は `orbitscore`（packages/engine/package.json の `bin`）だが、E2E は **dist を
 * 直接**叩く — グローバルインストールに依存しないため。`pretest:e2e:gated`
 * （package.json の該当スクリプト）が dist の鮮度を保証する。
 */
export function runOrbitscoreCli(
  args: readonly string[],
  opts?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number },
): CliResult {
  const startedAt = Date.now()
  try {
    const stdout = execFileSync(process.execPath, [CLI_ENTRY, ...args], {
      cwd: opts?.cwd ?? REPO_ROOT,
      env: opts?.env ?? process.env,
      timeout: opts?.timeoutMs ?? 30_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '', durationMs: Date.now() - startedAt }
  } catch (error) {
    const err = error as ExecFileSyncError
    return {
      status: err.status ?? -1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      durationMs: Date.now() - startedAt,
    }
  }
}
