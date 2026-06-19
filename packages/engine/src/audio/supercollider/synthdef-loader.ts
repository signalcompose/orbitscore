/**
 * SuperCollider SynthDefローダー
 */

import * as fs from 'fs'
import * as path from 'path'

import { OSCClient } from './osc-client'
import { EffectParams } from './types'

export class SynthDefLoader {
  private synthDefPath: string
  private linkSynthDefPath: string
  private linkKeepaliveSynthDefPath: string
  private effectSynths: Map<string, Map<string, number>> = new Map() // Track mastering effect synths by target and type
  private nextSynthId = 2000 // Start from 2000 to avoid conflicts with other synths

  constructor(private oscClient: OSCClient) {
    // __dirname is available in CommonJS context
    this.synthDefPath = path.join(
      __dirname,
      '../../../supercollider/synthdefs/orbitPlayBuf.scsyndef',
    )
    this.linkSynthDefPath = path.join(
      __dirname,
      '../../../supercollider/synthdefs/orbitPlayBufLink.scsyndef',
    )
    this.linkKeepaliveSynthDefPath = path.join(
      __dirname,
      '../../../supercollider/synthdefs/orbitLinkAudioKeepalive.scsyndef',
    )
  }

  /**
   * `/d_recv` 後にサーバへの SynthDef 反映を待つ固定ディレイ（best-effort）。
   * `d_recv` の完了 OSC を待たない簡易方式のため、各ロード箇所で共有する。
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * メインのSynthDefを読み込み
   */
  async loadMainSynthDef(): Promise<void> {
    if (!this.oscClient.isRunning()) {
      throw new Error('SuperCollider server not running')
    }

    const synthDefData = fs.readFileSync(this.synthDefPath)
    await this.oscClient.sendMessage(['/d_recv', synthDefData])

    // Wait for SynthDef to be ready
    await this.sleep(200)

    console.log('✅ SynthDef loaded')
  }

  /**
   * LinkAudio の `orbitPlayBufLink` SynthDef を読み込み (#209)。
   *
   * Best-effort: `.scsyndef` が存在しない (hardware-only ビルド) 場合は黙って
   * skip し、existing の hardware 経路を壊さない。実際にこの SynthDef が使われる
   * のは plugin が検出され outputChannel 付き sequence が再生されるときだけ。
   *
   * @returns ロードを試行して成功すれば true、ファイル不在/未起動なら false。
   */
  async loadLinkAudioSynthDef(): Promise<boolean> {
    if (!this.oscClient.isRunning()) {
      return false
    }
    if (!fs.existsSync(this.linkSynthDefPath)) {
      console.log(
        'ℹ️  orbitPlayBufLink.scsyndef not present — LinkAudio sample playback disabled (hardware-only build)',
      )
      return false
    }
    const synthDefData = fs.readFileSync(this.linkSynthDefPath)
    await this.oscClient.sendMessage(['/d_recv', synthDefData])
    await this.sleep(100)
    console.log('✅ orbitPlayBufLink SynthDef loaded')

    // Keepalive committer (#209) — keeps each LinkAudio channel's stream
    // continuous between transient sample hits. Best-effort: skip if absent.
    if (fs.existsSync(this.linkKeepaliveSynthDefPath)) {
      const keepaliveData = fs.readFileSync(this.linkKeepaliveSynthDefPath)
      await this.oscClient.sendMessage(['/d_recv', keepaliveData])
      await this.sleep(100)
      console.log('✅ orbitLinkAudioKeepalive SynthDef loaded')
    }
    return true
  }

  /**
   * マスタリングエフェクトSynthDefを読み込み
   */
  async loadMasteringEffectSynthDefs(): Promise<void> {
    if (!this.oscClient.isRunning()) {
      return
    }

    const synthDefDir = path.join(__dirname, '../../../supercollider/synthdefs')
    const effectSynthDefs = ['fxCompressor', 'fxLimiter', 'fxNormalizer']

    for (const synthDefName of effectSynthDefs) {
      const synthDefPath = path.join(synthDefDir, `${synthDefName}.scsyndef`)
      if (fs.existsSync(synthDefPath)) {
        const synthDefData = fs.readFileSync(synthDefPath)
        await this.oscClient.sendMessage(['/d_recv', synthDefData])
        await this.sleep(50)
      }
    }

    console.log('✅ Mastering effect SynthDefs loaded')
  }

  /**
   * マスタリングエフェクトを追加
   */
  async addEffect(target: string, effectType: string, params: EffectParams): Promise<void> {
    if (!this.oscClient.isRunning()) {
      console.error('⚠️  SuperCollider server not running')
      return
    }

    // Only support master effects
    if (target !== 'master') {
      console.error('⚠️  Only master effects are supported')
      return
    }

    // Map effect type to SynthDef name
    const synthDefMap: { [key: string]: string } = {
      compressor: 'fxCompressor',
      limiter: 'fxLimiter',
      normalizer: 'fxNormalizer',
    }

    const synthDefName = synthDefMap[effectType]
    if (!synthDefName) {
      console.error(`⚠️  Effect type ${effectType} not supported`)
      return
    }

    // Check if effect already exists
    let targetEffects = this.effectSynths.get(target)
    if (!targetEffects) {
      targetEffects = new Map()
      this.effectSynths.set(target, targetEffects)
    }

    const existingSynthId = targetEffects.get(effectType)

    try {
      if (existingSynthId !== undefined) {
        // Update existing effect parameters
        const setParams: any[] = ['/n_set', existingSynthId]

        Object.entries(params).forEach(([key, value]) => {
          setParams.push(key, value)
        })

        await this.oscClient.sendMessage(setParams)
        console.log(`✅ ${effectType} updated`)
      } else {
        // Create new effect synth with monotonically increasing ID
        const synthId = this.nextSynthId++
        const createParams: any[] = [
          '/s_new',
          synthDefName,
          synthId,
          1, // addToTail
          0, // target
        ]

        Object.entries(params).forEach(([key, value]) => {
          createParams.push(key, value)
        })

        await this.oscClient.sendMessage(createParams)

        // Store synth ID by effect type
        targetEffects.set(effectType, synthId)

        console.log(`✅ ${effectType} created (ID: ${synthId})`)
      }
    } catch (error) {
      console.error(`⚠️  Failed to add ${effectType}:`, error)
    }
  }

  /**
   * マスタリングエフェクトを削除
   */
  async removeEffect(target: string, effectType: string): Promise<void> {
    if (!this.oscClient.isRunning()) {
      return
    }

    const targetEffects = this.effectSynths.get(target)
    if (targetEffects) {
      const synthId = targetEffects.get(effectType)
      if (synthId !== undefined) {
        try {
          await this.oscClient.sendMessage(['/n_free', synthId])
          targetEffects.delete(effectType)
          console.log(`✅ ${effectType} removed (ID: ${synthId})`)
        } catch (error) {
          console.error('⚠️  Failed to free synth:', error)
        }
      }
    }
  }

  /**
   * アクティブなエフェクトのリストを取得
   */
  getActiveEffects(): Map<string, Map<string, number>> {
    return new Map(this.effectSynths)
  }

  /**
   * 特定のターゲットのアクティブなエフェクトを取得
   */
  getTargetEffects(target: string): Map<string, number> {
    return this.effectSynths.get(target) ?? new Map()
  }
}
