import type { AudioEngine } from '../../audio/types'
import { createStatePathFallback } from '../project-state-store'

import { AudioManager } from './audio-manager'
import { resolvePathDirect } from './audio-resolver'
import { EffectChainMap, normalizePluginInstanceName, type PluginSlot } from './effect-slot'
import { LinkAudioManager } from './link-audio-manager'
import { isPluginPathSpec, resolvePluginSpec, validatePluginExtension } from './plugin-resolver'

export interface PluginInstrumentReplacementHooks {
  beforeReplace(sequenceName: string, oldSlot: PluginSlot): Promise<void>
  onQuarantinedSlot?(sequenceName: string): void
}

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
    replacementHooks: PluginInstrumentReplacementHooks = {
      beforeReplace: async () => undefined,
    },
  ) {
    this.slots = new EffectChainMap(audioEngine, (seqName) => `seq:${seqName}`, {
      externalReceiverId: (seqName) => seqName,
      statePathFallback: createStatePathFallback(audioManager),
      replacement: { ...replacementHooks, failurePolicy: 'retain-on-reject' },
    })
  }

  hasDeclaration(): boolean {
    return this.slots.hasAny()
  }

  chainFor(sequenceName: string): readonly PluginSlot[] {
    return this.slots.chainFor(sequenceName)
  }

  /** Sequence names with a loaded plugin instrument. */
  keys(): readonly string[] {
    return this.slots.keys()
  }

  async instrument(
    seqName: string,
    spec: string,
    pluginId?: string,
    statePath?: string,
  ): Promise<void> {
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
        // #540 P2: 保存済み state（音色）。相対パスは document directory 基準で解決する。
        statePath: statePath === undefined ? undefined : this.resolveStatePath(statePath),
      },
      () =>
        `Sequence '${seqName}' already has an instrument instance; replacing it requires the Rust engine backend.`,
    )
  }

  /**
   * state ファイルの相対パスを document directory 基準で解決する（#540 P2）。
   * 音源 plugin と違い検索パス（audioPaths）は使わない — state は曲のプロジェクトに
   * 属する資産で、暗黙の検索で別プロジェクトの同名 state を拾う事故を避ける。
   */
  private resolveStatePath(statePath: string): string {
    // 既存の resolvePathDirect を再利用する（~ 展開・絶対パス・document directory 解決・
    // 未設定時 throw の検証済みロジック）。audioPaths は意図的に空配列。
    // 注: getDocumentDirectory() は未設定時 undefined ではなく **空文字列** を返すため、
    // 自前の `=== undefined` ガードは死んでいて cwd 相対に silent フォールバックしていた
    // （/simplify reuse レビューが検出した実バグ）。
    try {
      return resolvePathDirect(statePath, [], this.audioManager.getDocumentDirectory())
    } catch (err) {
      // 原因を本文に連結する（#542 レビュー: broad catch が resolvePathDirect の別の throw
      // 理由を「no document directory」と誤ラベルしたまま原因を失わないため。`{ cause }` は
      // tsconfig の lib が ES2022.Error を含まないため使わない）。
      const cause = err instanceof Error ? ` (cause: ${err.message})` : ''
      throw new Error(
        `instrument state path '${statePath}' is relative, but no document directory is set; ` +
          `use an absolute path or evaluate from a saved document.${cause}`,
      )
    }
  }
}
