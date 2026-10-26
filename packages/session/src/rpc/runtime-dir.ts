/**
 * runtime-dir と UDS のソケット（設計 848 §4.7・§6.2「発見」）。
 *
 * UDS の `/rpc` の境界はファイルの権限である: ディレクトリは **0700 で自分の所有**、ソケットは 0600。
 * session は起動時にこれを確かめ、広ければ起動しない（`{"ready":false,…}`）。ソケットそのものが
 * 発見の手段で、別のファイルに port や鍵を書かない。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const SOCKET_NAME = 'session.sock'

/** `sun_path` に入るバイト数（NUL を除く）。macOS は `sys/un.h` の `sun_path[104]`。 */
export function socketPathLimit(platform: NodeJS.Platform = process.platform): number {
  return platform === 'darwin' ? 103 : 107
}

/** 既定の runtime-dir。macOS は設計 §4.7 の場所。それ以外（開発・テスト用の Linux）はホームの下。 */
export function defaultRuntimeDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'OrbitStudio', 'run')
  }
  return path.join(os.homedir(), '.orbitstudio', 'run')
}

/** 起動引数 `--runtime-dir` → 環境変数 `ORBITSTUDIO_RUNTIME_DIR` → 既定（設計 §6.2）。 */
export function resolveRuntimeDir(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  return path.resolve(flag ?? env.ORBITSTUDIO_RUNTIME_DIR ?? defaultRuntimeDir())
}

export type Checked<T> = ({ ok: true } & T) | { ok: false; reason: string }

/**
 * ディレクトリを用意して検査する。無ければ 0700 で作る。在れば、ディレクトリであること・
 * 自分の所有であること・グループと他人に権限が無いことを確かめ、広ければ直さずに拒否する。
 */
export function prepareRuntimeDir(dir: string): Checked<{ dir: string }> {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700) // umask の影響を受けない
  }
  const stat = fs.lstatSync(dir)
  if (stat.isSymbolicLink()) return { ok: false, reason: `runtime dir is a symbolic link: ${dir}` }
  if (!stat.isDirectory()) return { ok: false, reason: `runtime dir is not a directory: ${dir}` }
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) {
    return { ok: false, reason: `runtime dir is not owned by the current user: ${dir}` }
  }
  if ((stat.mode & 0o077) !== 0) {
    return {
      ok: false,
      reason: `runtime dir must be mode 0700 (got ${(stat.mode & 0o777).toString(8)}): ${dir}`,
    }
  }
  return { ok: true, dir }
}

/**
 * ソケットのパスを決める。長すぎれば macOS では `getconf DARWIN_USER_TEMP_DIR` の下へ退避し
 * （`$TMPDIR` は親が書き換えることがあるので使わない）、それでも長ければ理由を返して起動しない
 * （#830 の「沈黙して落ちる」を繰り返さない）。
 */
export function resolveSocketPath(
  dir: string,
  options: { platform?: NodeJS.Platform; darwinUserTempDir?: () => string } = {},
): Checked<{ socketPath: string; dir: string }> {
  const platform = options.platform ?? process.platform
  const limit = socketPathLimit(platform)
  const primary = path.join(dir, SOCKET_NAME)
  if (Buffer.byteLength(primary) <= limit) return { ok: true, socketPath: primary, dir }
  if (platform === 'darwin') {
    const tempDir = (options.darwinUserTempDir ?? readDarwinUserTempDir)()
    const fallbackDir = path.join(tempDir, 'OrbitStudio')
    const fallback = path.join(fallbackDir, SOCKET_NAME)
    if (Buffer.byteLength(fallback) <= limit)
      return { ok: true, socketPath: fallback, dir: fallbackDir }
  }
  return {
    ok: false,
    reason: `socket path is longer than ${limit} bytes (${Buffer.byteLength(primary)}): ${primary}`,
  }
}

function readDarwinUserTempDir(): string {
  return execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim()
}

/**
 * 取り残しと二重起動（設計 §4.7）: 既存のソケットへ繋いでみて、`ECONNREFUSED` なら取り残し
 * なので消す。繋がれば別のセッションが動いているので起動しない。
 */
export async function claimSocketPath(socketPath: string): Promise<Checked<object>> {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true }
    throw error
  }
  if (!stat.isSocket())
    return { ok: false, reason: `not a socket, refusing to replace: ${socketPath}` }
  const live = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
  if (live) {
    return {
      ok: false,
      reason: `another session is already running on ${socketPath} (use a different --runtime-dir)`,
    }
  }
  fs.unlinkSync(socketPath)
  return { ok: true }
}
