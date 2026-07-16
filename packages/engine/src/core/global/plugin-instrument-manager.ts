import type { AudioEngine } from '../../audio/types'

import { AudioManager } from './audio-manager'
import { LinkAudioManager } from './link-audio-manager'
import { resolvePluginPath, validatePluginExtension } from './plugin-resolver'

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
    validatePluginExtension(spec, 'instrument')
    if (this.linkAudioManager.isEnabled()) {
      throw new Error('seq.instrument() cannot be used while LinkAudio is enabled in v1.')
    }

    const resolvedPath = resolvePluginPath(
      spec,
      this.audioManager.getAudioPaths(),
      this.audioManager.getDocumentDirectory(),
      'instrument',
    )
    const existing = this.declaration
    if (existing) {
      if (existing.resolvedPath === resolvedPath && existing.pluginId === pluginId) {
        await existing.load
        if (this.audioEngine.isPluginActive?.() === false) {
          await this.issueLoad(resolvedPath, pluginId)
        }
        return
      }
      throw new Error('seq.instrument() supports one instrument instance in v1.')
    }
    await this.issueLoad(resolvedPath, pluginId)
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
