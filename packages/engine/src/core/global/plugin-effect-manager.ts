import type { AudioEngine } from '../../audio/types'
import type { RackRecipe } from '../../signal-chain/rack'
import { createStatePathFallback } from '../project-state-store'

import { AudioManager } from './audio-manager'
import { LinkAudioManager } from './link-audio-manager'
import {
  EffectChainMap,
  resolveEffectRack,
  type ChainElement,
  type EffectChainMapOptions,
  toRackRecipe,
} from './effect-slot'

/** Owns the v1 master effect rack and applies each complete declaration eagerly. */
export class PluginEffectManager {
  /** Master rack bookkeeping uses one fixed receiver key. */
  private readonly slots: EffectChainMap<'master'>
  /** LinkAudio exclusion stays closed once this master insert has ever been declared. */
  private hasDeclared = false

  constructor(
    audioEngine: AudioEngine,
    private readonly audioManager: AudioManager,
    private readonly linkAudioManager: LinkAudioManager,
    replacement: NonNullable<EffectChainMapOptions<'master'>['replacement']>,
  ) {
    this.slots = new EffectChainMap(audioEngine, () => 'master', {
      externalReceiverId: () => 'master',
      effectBus: () => undefined,
      projectDirectory: () => audioManager.getDocumentDirectory(),
      statePathFallback: createStatePathFallback(audioManager),
      replacement,
    })
  }

  hasDeclaration(): boolean {
    return this.hasDeclared || this.slots.has('master')
  }

  hasUncertain(): boolean {
    return this.slots.hasUncertain('master')
  }

  chain(): readonly ChainElement[] {
    return this.slots.rackFor('master')
  }

  async effect(value: string | RackRecipe, pluginId?: string): Promise<void> {
    const recipe = toRackRecipe(value, pluginId)
    if (this.linkAudioManager.isEnabled()) {
      throw new Error('global.effect() cannot be used while LinkAudio is enabled in v1.')
    }
    const rack = resolveEffectRack(
      recipe,
      { audioManager: this.audioManager, linkAudioManager: this.linkAudioManager },
      'global.effect() cannot be used while LinkAudio is enabled in v1.',
    )
    await this.slots.applyRack('master', rack)
    this.hasDeclared = true
  }
}
