import type { AudioEngine } from '../../audio/types'

import { AudioManager } from './audio-manager'
import { EffectChainMap, normalizePluginInstanceName } from './effect-slot'
import { LinkAudioManager } from './link-audio-manager'
import { isPluginPathSpec, resolvePluginSpec, validatePluginExtension } from './plugin-resolver'

/** Owns the single v1 daemon instrument declaration shared by note sequences. */
export class PluginInstrumentManager {
  private readonly slots: EffectChainMap<'instrument'>

  constructor(
    audioEngine: AudioEngine,
    private readonly audioManager: AudioManager,
    private readonly linkAudioManager: LinkAudioManager,
  ) {
    this.slots = new EffectChainMap(audioEngine, () => 'instrument')
  }

  hasDeclaration(): boolean {
    return this.slots.has('instrument')
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
    await this.slots.declare(
      'instrument',
      undefined,
      'instrument',
      normalizePluginInstanceName(spec),
      resolved.path,
      resolved.pluginId,
      () => new Error('seq.instrument() supports one instrument instance in v1.'),
    )
  }
}
