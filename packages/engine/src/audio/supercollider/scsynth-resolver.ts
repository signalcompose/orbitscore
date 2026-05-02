/**
 * scsynth binary path resolver.
 *
 * 優先順位:
 *   1. explicit (caller 明示)
 *   2. env (ORBIT_SCSYNTH_PATH)
 *   3. bundle (extension 同梱、`<engine root>/scsynth/Contents/Resources/scsynth`)
 *   4. SC.app fallback (`/Applications/SuperCollider.app/Contents/Resources/scsynth`)
 *   5. Spotlight (`mdfind` で SuperCollider.app を検索)
 *
 * パターンは `packages/engine/src/audio/rust-engine/daemon-client.ts` の
 * `resolveDaemonBinary()` を流用。各候補は `fs.existsSync` + 実行権限を検査。
 */

import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

export type ScsynthSource = 'explicit' | 'env' | 'bundle' | 'sc-app' | 'spotlight'

export interface ScsynthResolution {
  path: string
  source: ScsynthSource
  searched: string[]
}

export interface ResolveOptions {
  explicit?: string
}

export class ScsynthNotFoundError extends Error {
  public readonly searched: string[]

  constructor(searched: string[]) {
    super(
      `scsynth binary not found. Searched paths:\n${searched.map((p) => '  - ' + p).join('\n')}`,
    )
    this.name = 'ScsynthNotFoundError'
    this.searched = searched
  }
}

const SC_APP_DEFAULT_PATH = '/Applications/SuperCollider.app/Contents/Resources/scsynth'
const SPOTLIGHT_TIMEOUT_MS = 500
const ENV_VAR = 'ORBIT_SCSYNTH_PATH'

/**
 * `<engine root>/scsynth/Contents/Resources/scsynth` を計算。
 *
 * - vscode-extension 同梱: `packages/vscode-extension/engine/dist/audio/supercollider/scsynth-resolver.js`
 *   から見ると `engine/scsynth/...` は `../../../scsynth/...`
 * - engine package 単独: `packages/engine/dist/audio/supercollider/scsynth-resolver.js`
 *   から見ると bundle は存在しない (常に miss → 次候補へ)
 */
function bundleCandidatePath(): string {
  return path.resolve(__dirname, '../../../scsynth/Contents/Resources/scsynth')
}

function isExecutableFile(p: string): boolean {
  try {
    const stat = fs.statSync(p)
    if (!stat.isFile()) return false
    return (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

function findViaSpotlight(): string | null {
  try {
    const result = spawnSync('mdfind', ['-name', 'SuperCollider.app'], {
      timeout: SPOTLIGHT_TIMEOUT_MS,
      encoding: 'utf8',
    })
    if (result.status !== 0 || !result.stdout) return null
    const firstHit = result.stdout
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.length > 0)
    if (!firstHit) return null
    return path.join(firstHit, 'Contents/Resources/scsynth')
  } catch {
    return null
  }
}

/**
 * scsynth binary を解決する。
 *
 * @throws {ScsynthNotFoundError} 全候補 miss 時
 */
export function resolveScsynthPath(opts: ResolveOptions = {}): ScsynthResolution {
  const searched: string[] = []

  const tryCandidate = (
    candidate: string | null | undefined,
    source: ScsynthSource,
  ): ScsynthResolution | null => {
    if (!candidate) return null
    searched.push(candidate)
    if (isExecutableFile(candidate)) {
      return { path: candidate, source, searched: [...searched] }
    }
    return null
  }

  return (
    tryCandidate(opts.explicit, 'explicit') ??
    tryCandidate(process.env[ENV_VAR], 'env') ??
    tryCandidate(bundleCandidatePath(), 'bundle') ??
    tryCandidate(SC_APP_DEFAULT_PATH, 'sc-app') ??
    tryCandidate(findViaSpotlight(), 'spotlight') ??
    (() => {
      throw new ScsynthNotFoundError(searched)
    })()
  )
}
