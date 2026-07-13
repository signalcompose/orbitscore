import path from 'node:path'

import type { AudioEngine } from '../../audio/types'

import { AudioManager } from './audio-manager'
import { resolvePathDirect } from './audio-resolver'
import { LinkAudioManager } from './link-audio-manager'

interface EffectDeclaration {
  resolvedPath: string
  pluginId?: string
  load: Promise<void>
}

/** Owns the single v1 master-insert plugin declaration and eager load. */
export class PluginEffectManager {
  private declaration?: EffectDeclaration

  constructor(
    private readonly audioEngine: AudioEngine,
    private readonly audioManager: AudioManager,
    private readonly linkAudioManager: LinkAudioManager,
  ) {}

  hasDeclaration(): boolean {
    return this.declaration !== undefined
  }

  async effect(spec: string, pluginId?: string): Promise<void> {
    this.validateExtension(spec)

    if (this.linkAudioManager.isEnabled()) {
      throw new Error('global.effect() cannot be used while LinkAudio is enabled in v1.')
    }

    const resolvedPath = resolvePathDirect(
      spec,
      this.audioManager.getAudioPaths(),
      this.audioManager.getDocumentDirectory(),
    )
    const existing = this.declaration
    if (existing) {
      if (existing.resolvedPath === resolvedPath && existing.pluginId === pluginId) {
        await existing.load
        return
      }
      throw new Error(
        'global.effect() supports one master insert in v1; effect chains are reserved for future support.',
      )
    }

    if (!this.audioEngine.loadPlugin) {
      throw new Error('Plugin hosting requires the Rust engine backend.')
    }

    const load = this.audioEngine.loadPlugin(resolvedPath, pluginId).then(() => undefined)
    const declaration: EffectDeclaration = { resolvedPath, pluginId, load }
    this.declaration = declaration
    try {
      await load
    } catch (err) {
      if (this.declaration === declaration) this.declaration = undefined
      throw err
    }
  }

  private validateExtension(spec: string): void {
    const extension = path.extname(spec).toLowerCase()
    if (extension === '.clap') return
    if (extension === '.vst3' || extension === '.component') {
      throw new Error(
        `${extension} plugins are not yet supported (reserved for future VST3/AU support).`,
      )
    }
    throw new Error(`Unknown plugin extension "${extension || '(none)'}"; expected .clap.`)
  }
}
