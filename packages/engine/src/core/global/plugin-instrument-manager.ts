import type { AudioEngine } from '../../audio/types'

import { AudioManager } from './audio-manager'
import { EffectChainMap, normalizePluginInstanceName } from './effect-slot'
import { LinkAudioManager } from './link-audio-manager'
import { isPluginPathSpec, resolvePluginSpec, validatePluginExtension } from './plugin-resolver'

/**
 * Owns per-sequence daemon instrument declarations (#540 P1). Each note sequence
 * gets an independent instrument instance — the map key is the sequence name and
 * the wire `instance` ID follows the note path's `plugin:<seqName>` port
 * convention (`Sequence.resolveNoteTarget()`), so declarations and notes address
 * the same daemon slot.
 */
export class PluginInstrumentManager {
  private readonly slots: EffectChainMap<string>

  constructor(
    audioEngine: AudioEngine,
    private readonly audioManager: AudioManager,
    private readonly linkAudioManager: LinkAudioManager,
  ) {
    this.slots = new EffectChainMap(audioEngine, (seqName) => `seq:${seqName}`)
  }

  hasDeclaration(): boolean {
    return this.slots.size > 0
  }

  async instrument(seqName: string, spec: string, pluginId?: string): Promise<void> {
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
      seqName,
      {
        role: 'instrument',
        bus: undefined,
        normalizedName: normalizePluginInstanceName(spec),
        resolvedPath: resolved.path,
        pluginId: resolved.pluginId,
        // note 側 `resolveNoteTarget()` の port（`plugin:<seqName>`）と同じ規約。
        instance: `plugin:${seqName}`,
      },
      () =>
        `Sequence '${seqName}' already has an instrument instance; ` +
        'v1 does not support replacing it (restart the engine to change the plugin).',
    )
  }
}
