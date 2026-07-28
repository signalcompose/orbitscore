import type { AudioEngine } from '../../audio/types'

import { AudioManager } from './audio-manager'
import { LinkAudioManager } from './link-audio-manager'
import {
  EffectChainMap,
  normalizePluginInstanceName,
  resolveEffectSpec,
  type PluginSlot,
} from './effect-slot'

/** Owns the single v1 master-insert plugin declaration and eager load. */
export class PluginEffectManager {
  /** v1 master insert を固定 key の chain（上限 1）に載せる。 */
  private readonly slots: EffectChainMap<'master'>

  constructor(
    audioEngine: AudioEngine,
    private readonly audioManager: AudioManager,
    private readonly linkAudioManager: LinkAudioManager,
  ) {
    this.slots = new EffectChainMap(audioEngine, () => 'master')
  }

  hasDeclaration(): boolean {
    return this.slots.has('master')
  }

  chain(): readonly PluginSlot[] {
    return this.slots.chainFor('master')
  }

  async effect(spec: string, pluginId?: string): Promise<void> {
    const resolved = resolveEffectSpec(
      spec,
      pluginId,
      { audioManager: this.audioManager, linkAudioManager: this.linkAudioManager },
      'global.effect() cannot be used while LinkAudio is enabled in v1.',
    )
    await this.slots.declare(
      'master',
      {
        role: 'effect',
        bus: undefined,
        normalizedName: normalizePluginInstanceName(spec),
        resolvedPath: resolved.path,
        pluginId: resolved.pluginId,
      },
      () =>
        'global.effect() supports one master insert in v1; effect chains are reserved for future support.',
    )
  }
}
