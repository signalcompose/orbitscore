/**
 * scsynth binary path resolver.
 *
 * 優先順位 (strict mode — Issue #136 の "SC 不要で動く" を保証するため
 * SC.app / Spotlight への暗黙 fallback は意図的に持たない):
 *   1. explicit (caller 明示)
 *   2. env (ORBIT_SCSYNTH_PATH)
 *   3. bundle (extension 同梱、`<engine root>/scsynth/Contents/Resources/scsynth`)
 *
 * 全 miss 時は `ScsynthNotFoundError` を投げ、bundle が無い状況を「サイレントに
 * SC.app で誤魔化す」のではなく明示的に検知できるようにする。dev 環境で
 * SC.app を使いたい場合は `ORBIT_SCSYNTH_PATH=/Applications/SuperCollider.app/...`
 * を env で渡すこと。
 *
 * パターンは `packages/engine/src/audio/rust-engine/daemon-client.ts` の
 * `resolveDaemonBinary()` を流用。各候補は `fs.statSync` + 実行権限を検査。
 */

import * as fs from 'fs'
import * as path from 'path'

export type ScsynthSource = 'explicit' | 'env' | 'bundle'

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
      `scsynth binary not found. Searched paths:\n${searched.map((p) => '  - ' + p).join('\n')}\n\n` +
        `For development without a bundled scsynth, set ORBIT_SCSYNTH_PATH to a system scsynth (e.g. /Applications/SuperCollider.app/Contents/Resources/scsynth).`,
    )
    this.name = 'ScsynthNotFoundError'
    this.searched = searched
  }
}

const ENV_VAR = 'ORBIT_SCSYNTH_PATH'

/**
 * `<engine root>/scsynth/Contents/Resources/scsynth` を計算。
 *
 * - vscode-extension 同梱: `packages/vscode-extension/engine/dist/audio/supercollider/scsynth-resolver.js`
 *   から見ると `engine/scsynth/...` は `../../../scsynth/...`
 * - engine package 単独: `packages/engine/dist/audio/supercollider/scsynth-resolver.js`
 *   から見ると bundle は存在しない (常に miss → エラー、dev は env 経由で解決)
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
    (() => {
      throw new ScsynthNotFoundError(searched)
    })()
  )
}
