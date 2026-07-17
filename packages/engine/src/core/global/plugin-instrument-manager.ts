import type { AudioEngine } from '../../audio/types'

import { AudioManager } from './audio-manager'
import { LinkAudioManager } from './link-audio-manager'
import { isPluginPathSpec, resolvePluginSpec, validatePluginExtension } from './plugin-resolver'

interface InstrumentDeclaration {
  resolvedPath: string
  pluginId?: string
  load: Promise<void>
}

/** Owns the single v1 daemon instrument declaration shared by note sequences. */
export class PluginInstrumentManager {
  private declaration?: InstrumentDeclaration

  constructor(
    private readonly audioEngine: AudioEngine,
    private readonly audioManager: AudioManager,
    private readonly linkAudioManager: LinkAudioManager,
  ) {}

  hasDeclaration(): boolean {
    return this.declaration !== undefined
  }

  async instrument(spec: string, pluginId?: string): Promise<void> {
    // 拡張子検証は path-direct spec にのみ適用する（#463 C2: カタログ名はここで弾かず、
    // resolvePluginSpec のカタログ解決に委ねる — effect-slot.ts の resolveEffectSpec と同型）。
    if (isPluginPathSpec(spec)) {
      validatePluginExtension(spec, 'instrument')
    }
    if (this.linkAudioManager.isEnabled()) {
      throw new Error('seq.instrument() cannot be used while LinkAudio is enabled in v1.')
    }

    const resolved = resolvePluginSpec(
      spec,
      pluginId,
      this.audioManager.getAudioPaths(),
      this.audioManager.getDocumentDirectory(),
      'instrument',
    )
    const resolvedPath = resolved.path
    const resolvedPluginId = resolved.pluginId
    const existing = this.declaration
    if (existing) {
      if (existing.resolvedPath === resolvedPath && existing.pluginId === resolvedPluginId) {
        await existing.load
        if (this.audioEngine.isPluginActive?.('instrument') === false) {
          await this.issueLoad(resolvedPath, resolvedPluginId)
        }
        return
      }
      throw new Error('seq.instrument() supports one instrument instance in v1.')
    }
    await this.issueLoad(resolvedPath, resolvedPluginId)
  }

  private async issueLoad(resolvedPath: string, pluginId: string | undefined): Promise<void> {
    if (!this.audioEngine.loadPlugin) {
      throw new Error('Plugin hosting requires the Rust engine backend.')
    }
    const load = this.audioEngine
      .loadPlugin(resolvedPath, pluginId, 'instrument')
      .then(() => undefined)
    const declaration = { resolvedPath, pluginId, load }
    this.declaration = declaration
    try {
      await load
    } catch (err) {
      if (this.declaration === declaration) this.declaration = undefined
      throw err
    }
  }
}
