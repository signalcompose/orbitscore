/**
 * SuperCollider SynthDefローダー
 */

import * as fs from 'fs'
import * as path from 'path'

import { OSCClient } from './osc-client'
import { EffectParams } from './types'

export class SynthDefLoader {
  private synthDefPath: string
  private effectSynths: Map<string, Map<string, number>> = new Map() // Track mastering effect synths by target and type
  private nextSynthId = 2000 // Start from 2000 to avoid conflicts with other synths

  constructor(private oscClient: OSCClient) {
    // __dirname is available in CommonJS context
    this.synthDefPath = path.join(
      __dirname,
      '../../../supercollider/synthdefs/orbitPlayBuf.scsyndef',
    )
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
    await new Promise((resolve) => setTimeout(resolve, 200))

    console.log('✅ SynthDef loaded')
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
        await new Promise((resolve) => setTimeout(resolve, 50))
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
