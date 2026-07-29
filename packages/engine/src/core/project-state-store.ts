import * as fs from 'fs'
import * as path from 'path'

import { stringify, parse } from 'yaml'

import type { AudioEngine, PluginStateSaveResult, PluginStateSaveTarget } from '../audio/types'

export interface PluginStateIdentity {
  receiver: string
  role: 'effect' | 'instrument'
  normalizedName: string
  occurrence: number
}

export interface SavedProjectPluginState extends PluginStateSaveResult {
  identity: PluginStateIdentity
  identityKey: string
  projectFile: string
  projectStatePath: string
}

interface ProjectManifest {
  version: number
  states: Record<string, string>
  [key: string]: unknown
}

function identityKey(identity: PluginStateIdentity): string {
  return [
    identity.receiver,
    identity.role,
    identity.normalizedName,
    String(identity.occurrence),
  ].join('/')
}

/** SC.5 identity keyをUTF-8 JSON経由のbase64urlへ写す、可逆・衝突不能なファイル名。 */
export function stateFileNameForIdentity(identity: PluginStateIdentity): string {
  const encoded = Buffer.from(
    JSON.stringify([
      identity.receiver,
      identity.role,
      identity.normalizedName,
      identity.occurrence,
    ]),
    'utf8',
  ).toString('base64url')
  return `${encoded}.state`
}

function parseManifest(source: string, manifestPath: string): ProjectManifest {
  let value: unknown
  try {
    value = parse(source)
  } catch (error) {
    throw new Error(
      `Cannot parse plugin state manifest '${manifestPath}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Plugin state manifest '${manifestPath}' must contain a YAML mapping.`)
  }
  const manifest = value as Record<string, unknown>
  if (manifest.version !== 1) {
    throw new Error(
      `Plugin state manifest '${manifestPath}' has unsupported version ${String(manifest.version)}.`,
    )
  }
  if (
    typeof manifest.states !== 'object' ||
    manifest.states === null ||
    Array.isArray(manifest.states) ||
    Object.values(manifest.states).some((entry) => typeof entry !== 'string')
  ) {
    throw new Error(`Plugin state manifest '${manifestPath}' has an invalid 'states' mapping.`)
  }
  return manifest as ProjectManifest
}

/**
 * project.yaml の SC.5 identity 登記を、daemon に渡せる絶対 state path へ解決する。
 *
 * document context が無い場合と manifest / identity が未登記の場合は通常状態として no-op。
 * manifest 自体の破損は parseManifest の既存契約どおり throw し、登記済みファイルだけが
 * 欠損している場合は音を止めず state 無しへ degrade する（stderr には診断を残す）。
 *
 * project.yaml は `.orbs` と同じローカルプロジェクト内にあり、同一の信頼ドメインとして扱う。
 * そのため手編集された登記値の絶対パスや `../` による project 外参照はユーザーの責任範囲。
 * 書き込み側は常に `projectDirectory/states/<決定論的ファイル名>` を使うため、保存処理から
 * project 外へ書き出すことは構造的にできない。
 */
export async function resolveRegisteredPluginStatePath(
  projectDirectory: string,
  identity: PluginStateIdentity,
): Promise<string | undefined> {
  // AudioManager.getDocumentDirectory() は未設定時に空文字列を返す。ここを path.join() より
  // 前で止めないと、engine の cwd にある project.yaml を暗黙に読むことになる。
  if (!projectDirectory) {
    return undefined
  }

  const key = identityKey(identity)
  const manifestPath = path.join(projectDirectory, 'project.yaml')
  let source: string
  try {
    source = await fs.promises.readFile(manifestPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    // 原因を本文に連結する（PluginInstrumentManager.resolveStatePath と同型）。
    // `{ cause }` は tsconfig の lib が ES2022.Error を含まないため使わない。
    const cause = error instanceof Error ? ` (cause: ${error.message})` : ''
    throw new Error(
      `Cannot read plugin state manifest '${manifestPath}' for identity '${key}'.${cause}`,
    )
  }
  const manifest = parseManifest(source, manifestPath)

  const registeredPath = manifest.states[key]
  if (registeredPath === undefined) {
    return undefined
  }

  const absoluteStatePath = path.resolve(projectDirectory, registeredPath)
  let stateStats: fs.Stats
  try {
    stateStats = await fs.promises.stat(absoluteStatePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const detail = error instanceof Error ? ` (${code ?? 'unknown'}: ${error.message})` : ''
    console.error(
      `Registered plugin state '${absoluteStatePath}' for '${key}' ${
        code === 'ENOENT' ? 'does not exist' : `is not readable${detail}`
      }; loading the plugin without state.`,
    )
    return undefined
  }
  if (!stateStats.isFile()) {
    console.error(
      `Registered plugin state '${absoluteStatePath}' for '${key}' is not a file; ` +
        'loading the plugin without state.',
    )
    return undefined
  }
  try {
    await fs.promises.access(absoluteStatePath, fs.constants.R_OK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const detail = error instanceof Error ? ` (${code ?? 'unknown'}: ${error.message})` : ''
    console.error(
      `Registered plugin state '${absoluteStatePath}' for '${key}' ${
        code === 'ENOENT' ? 'does not exist' : `is not readable${detail}`
      }; loading the plugin without state.`,
    )
    return undefined
  }
  return absoluteStatePath
}

export function createStatePathFallback(directoryProvider: {
  getDocumentDirectory(): string
}): (identity: PluginStateIdentity) => Promise<string | undefined> {
  return (identity) =>
    resolveRegisteredPluginStatePath(directoryProvider.getDocumentDirectory(), identity)
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * plugin state本体のdaemon保存とproject.yaml登記を直列化する。
 * state保存に失敗した場合はmanifestを一切変更しない。
 */
export class ProjectStateStore {
  private pending: Promise<void> = Promise.resolve()

  constructor(
    private readonly projectDirectory: string,
    private readonly audioEngine: AudioEngine,
  ) {
    if (!path.isAbsolute(projectDirectory)) {
      throw new Error(`Project directory must be absolute: '${projectDirectory}'.`)
    }
  }

  save(
    identity: PluginStateIdentity,
    target: PluginStateSaveTarget,
  ): Promise<SavedProjectPluginState> {
    const result = this.pending.catch(() => undefined).then(() => this.saveBody(identity, target))
    this.pending = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async saveBody(
    identity: PluginStateIdentity,
    target: PluginStateSaveTarget,
  ): Promise<SavedProjectPluginState> {
    if (!this.audioEngine.savePluginState) {
      throw new Error('Plugin state saving requires the Rust engine backend.')
    }
    const key = identityKey(identity)
    const statesDirectory = path.join(this.projectDirectory, 'states')
    const relativeStatePath = `states/${stateFileNameForIdentity(identity)}`
    const absoluteStatePath = path.join(this.projectDirectory, ...relativeStatePath.split('/'))
    await fs.promises.mkdir(statesDirectory, { recursive: true })

    const saved = await this.audioEngine.savePluginState(target, absoluteStatePath)
    if (!(saved.bytesWritten > 0)) {
      throw new Error(`Plugin state save returned an invalid byte count: ${saved.bytesWritten}.`)
    }

    const manifestPath = path.join(this.projectDirectory, 'project.yaml')
    let manifest: ProjectManifest
    try {
      const source = await fs.promises.readFile(manifestPath, 'utf8')
      manifest = parseManifest(source, manifestPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      manifest = { version: 1, states: {} }
    }
    manifest.states[key] = relativeStatePath

    const tempPath = path.join(
      this.projectDirectory,
      `.project.yaml.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    )
    let tempCreated = false
    try {
      const handle = await fs.promises.open(tempPath, 'wx')
      tempCreated = true
      try {
        await handle.writeFile(stringify(manifest), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.promises.rename(tempPath, manifestPath)
      tempCreated = false
      await syncDirectory(this.projectDirectory)
    } finally {
      if (tempCreated) await fs.promises.rm(tempPath, { force: true })
    }

    return {
      ...saved,
      identity,
      identityKey: key,
      projectFile: manifestPath,
      projectStatePath: relativeStatePath,
    }
  }
}

const projectStateStoresByAudioEngine = new WeakMap<AudioEngine, Map<string, ProjectStateStore>>()

/**
 * One store per audio engine and absolute project directory. Sharing the store
 * makes its pending chain the serialization boundary for every Global owned by
 * one interpreter, including fire-and-forget stop snapshots.
 */
export function projectStateStoreFor(
  audioEngine: AudioEngine,
  projectDirectory: string,
): ProjectStateStore {
  const absoluteDirectory = path.resolve(projectDirectory)
  let storesByDirectory = projectStateStoresByAudioEngine.get(audioEngine)
  if (!storesByDirectory) {
    storesByDirectory = new Map()
    projectStateStoresByAudioEngine.set(audioEngine, storesByDirectory)
  }
  let store = storesByDirectory.get(absoluteDirectory)
  if (!store) {
    store = new ProjectStateStore(absoluteDirectory, audioEngine)
    storesByDirectory.set(absoluteDirectory, store)
  }
  return store
}
