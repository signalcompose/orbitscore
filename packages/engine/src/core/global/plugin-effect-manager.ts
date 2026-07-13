import type { AudioEngine } from '../../audio/types'

import { AudioManager } from './audio-manager'
import { LinkAudioManager } from './link-audio-manager'
import { resolvePluginPath, validatePluginExtension } from './plugin-resolver'

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
    // Order is load-bearing: validate the spec, then gate on LinkAudio, and
    // only then resolve the path. A relative spec with no document context
    // yet (unsaved file) makes `resolvePluginPath` throw a "cannot resolve"
    // error; if that ran before the LinkAudio gate, it would mask the more
    // relevant LinkAudio-conflict error with a confusing resolve failure.
    validatePluginExtension(spec)

    if (this.linkAudioManager.isEnabled()) {
      throw new Error('global.effect() cannot be used while LinkAudio is enabled in v1.')
    }

    const resolvedPath = resolvePluginPath(
      spec,
      this.audioManager.getAudioPaths(),
      this.audioManager.getDocumentDirectory(),
    )

    const existing = this.declaration
    if (existing) {
      if (existing.resolvedPath === resolvedPath && existing.pluginId === pluginId) {
        await existing.load
        // Self-heal: `isPluginActive() === false` means a prior daemon respawn
        // failed to restore this plugin in the engine even though our cache
        // still thinks it succeeded (silent-failure guard). Re-issue the load
        // instead of returning a false "success". Engines without
        // `isPluginActive` (SC backend / plain mocks) keep the old no-op
        // idempotent behavior.
        if (this.audioEngine.isPluginActive?.() === false) {
          await this.issueLoad(resolvedPath, pluginId)
        }
        return
      }
      throw new Error(
        'global.effect() supports one master insert in v1; effect chains are reserved for future support.',
      )
    }

    await this.issueLoad(resolvedPath, pluginId)
  }

  /** Issues (or re-issues) the load, installing the declaration and clearing it on failure. */
  private async issueLoad(resolvedPath: string, pluginId: string | undefined): Promise<void> {
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
}
