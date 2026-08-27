/**
 * #468/#472: self-heal 再ロード失敗時の bus 温存をピン留めする回帰テスト。
 *
 * 旧実装（3 manager 複製時代）は self-heal 失敗で宣言ごと bus を消していたが、
 * routing（seq.output()/send()）が参照中の bus 名が失われる + LinkAudio 排他ゲート
 * （hasAnyDeclaration）が緩む問題があった。統合後は bus を温存する（MixerManager の
 * 従来挙動と一致）。この意味論が黙って戻らないようにする。
 */

import { describe, it, expect, vi } from 'vitest'

import { SequenceEffectManager } from '../../packages/engine/src/core/global/sequence-effect-manager'
import { AudioManager } from '../../packages/engine/src/core/global/audio-manager'
import { LinkAudioManager } from '../../packages/engine/src/core/global/link-audio-manager'
import { installEffectChainMock } from '../helpers/effect-chain-mock'

function harness() {
  const loadPlugin = vi.fn().mockResolvedValue({})
  const isPluginActive = vi.fn().mockReturnValue(true)
  const audioEngine = { loadPlugin, isPluginActive } as any
  const applyEffectChain = installEffectChainMock(audioEngine)
  const audioManager = new AudioManager()
  audioManager.setDocumentDirectory('/songs')
  const manager = new SequenceEffectManager(
    audioEngine,
    audioManager,
    new LinkAudioManager(audioEngine),
  )
  return { manager, loadPlugin, isPluginActive, applyEffectChain }
}

describe('SequenceEffectManager — self-heal reload failure keeps the bus (#472)', () => {
  it('keeps hasDeclaration()/getBus() and does not recycle the bus into the pool', async () => {
    const { manager, applyEffectChain } = harness()
    const bus = await manager.effect('kick', './echo.clap')
    expect(bus).toBe('seq-bus-0')

    // An identical rack still probes daemon health; simulate a transport failure there.
    applyEffectChain.mockRejectedValueOnce(new Error('reload failed'))
    await expect(manager.effect('kick', './echo.clap')).rejects.toThrow('reload failed')

    // bus は温存される（routing が参照中・LinkAudio 排他ゲートも維持）
    expect(manager.hasDeclaration('kick')).toBe(true)
    expect(manager.hasAnyDeclaration()).toBe(true)
    expect(manager.getBus('kick')).toBe('seq-bus-0')

    // 別シーケンスの新規宣言が kick の bus を再利用しない（pool へ返却されていない）
    const other = await manager.effect('snare', './comp.clap')
    expect(other).toBe('seq-bus-1')
  })

  it('a retry after the failed self-heal reuses the SAME bus and succeeds', async () => {
    const { manager, applyEffectChain } = harness()
    await manager.effect('kick', './echo.clap')
    applyEffectChain.mockRejectedValueOnce(new Error('reload failed'))
    await expect(manager.effect('kick', './echo.clap')).rejects.toThrow('reload failed')

    const bus = await manager.effect('kick', './echo.clap')
    expect(bus).toBe('seq-bus-0')
  })
})
