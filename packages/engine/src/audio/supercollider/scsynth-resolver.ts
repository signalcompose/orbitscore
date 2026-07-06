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
 * explicit / env は「ユーザー明示の意図」なので、存在するが実行不可の場合は後続候補
 * (bundle) へ silent に fall-through せず `ScsynthNotExecutableError` を投げる
 * (Issue #383)。bundle は自動探索候補なので miss しても通常どおり次に進む。
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

/**
 * explicit / env override が「存在するが実行不可」の場合に投げる (Issue #383)。
 *
 * 自動探索候補 (bundle) 同士の fall-through は設計どおり許容するが、ユーザー明示の
 * override だけは silent substitution (無関係のバイナリへ無警告ですり替わる) を防ぐため
 * 後続候補へ fall-through せず即座に fail loud する。
 */
export class ScsynthNotExecutableError extends Error {
  public readonly path: string
  public readonly source: 'explicit' | 'env'

  constructor(path: string, source: 'explicit' | 'env') {
    const originDesc = source === 'env' ? `env var ${ENV_VAR}` : 'explicit option'
    super(
      `scsynth override via ${originDesc} points to a file that exists but is not executable: ${path}\n\n` +
        `Fix the permissions (chmod +x) or unset the override; it will not silently fall back to another scsynth.`,
    )
    this.name = 'ScsynthNotExecutableError'
    this.path = path
    this.source = source
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

type CandidateProbe = 'executable' | 'not-executable' | 'absent'

function probeCandidate(p: string): CandidateProbe {
  let stat: fs.Stats
  try {
    stat = fs.statSync(p)
  } catch {
    return 'absent'
  }
  if (!stat.isFile()) return 'absent'
  return (stat.mode & 0o111) !== 0 ? 'executable' : 'not-executable'
}

/**
 * scsynth binary を解決する。
 *
 * explicit / env は「ユーザー明示の意図」のため、存在するが実行不可な場合は後続候補へ
 * fall-through せず `ScsynthNotExecutableError` を投げる (silent substitution 防止・Issue #383)。
 * bundle は自動探索候補のため、miss 時は通常どおり `ScsynthNotFoundError` に落ちる。
 *
 * @throws {ScsynthNotExecutableError} explicit/env が存在するが実行不可な場合
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
    const probe = probeCandidate(candidate)
    if (probe === 'executable') {
      return { path: candidate, source, searched: [...searched] }
    }
    if (probe === 'not-executable' && (source === 'explicit' || source === 'env')) {
      throw new ScsynthNotExecutableError(candidate, source)
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
