/**
 * SuperColliderバッファ管理
 */

import * as path from 'path'
import { execFileSync } from 'child_process'

import { BufferInfo } from './types'
import { OSCClient } from './osc-client'

export class BufferManager {
  private bufferCache: Map<string, BufferInfo> = new Map()
  private bufferDurations: Map<number, number> = new Map()
  private nextBufnum = 0

  constructor(private oscClient: OSCClient) {}

  /**
   * オーディオファイルをバッファに読み込み
   */
  async loadBuffer(filepath: string): Promise<BufferInfo> {
    if (this.bufferCache.has(filepath)) {
      return this.bufferCache.get(filepath)!
    }

    const bufnum = this.nextBufnum++

    // Get duration from audio file using sox before loading into SuperCollider
    const duration = this.getAudioFileDuration(filepath)

    // Wait for SuperCollider to complete buffer loading (/done message)
    await this.oscClient.sendBufferLoad(bufnum, filepath)

    const bufferInfo: BufferInfo = { bufnum, duration }
    this.bufferCache.set(filepath, bufferInfo)
    this.bufferDurations.set(bufnum, duration)

    // Only log in debug mode
    if (process.env.ORBITSCORE_DEBUG) {
      console.log(
        `📦 Loaded buffer ${bufnum} (${path.basename(filepath)}): ${duration.toFixed(3)}s`,
      )
    }

    return bufferInfo
  }

  /**
   * soxを使用してオーディオファイルの長さを取得
   * execFileSyncを使用してコマンドインジェクション攻撃を防止
   */
  private getAudioFileDuration(filepath: string): number {
    try {
      // Use execFileSync with separate arguments to prevent command injection
      // Suppress soxi warnings by redirecting stderr to /dev/null
      const output = execFileSync('soxi', ['-D', filepath], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'], // Ignore stderr to suppress warnings
      })
      const duration = parseFloat(output.trim())

      if (isNaN(duration) || duration <= 0) {
        console.warn(`⚠️  Invalid duration from sox for ${filepath}, using default 0.3s`)
        return 0.3
      }

      return duration
    } catch (error: any) {
      console.warn(
        `⚠️  Failed to get duration for ${filepath}: ${error.message}, using default 0.3s`,
      )
      return 0.3
    }
  }

  /**
   * キャッシュからオーディオの長さを取得
   */
  getAudioDuration(filepath: string): number {
    const bufferInfo = this.bufferCache.get(filepath)
    if (!bufferInfo) {
      console.warn(`⚠️  No buffer cached for ${filepath}, using default 0.3s`)
      return 0.3 // Default for drum samples
    }
    return bufferInfo.duration
  }

  /**
   * バッファキャッシュをクリア
   */
  clearCache(): void {
    this.bufferCache.clear()
    this.bufferDurations.clear()
    this.nextBufnum = 0
  }

  /**
   * 特定のファイルのバッファを削除
   */
  removeBuffer(filepath: string): boolean {
    const bufferInfo = this.bufferCache.get(filepath)
    if (bufferInfo) {
      this.bufferCache.delete(filepath)
      this.bufferDurations.delete(bufferInfo.bufnum)
      return true
    }
    return false
  }

  /**
   * バッファキャッシュの統計情報を取得
   */
  getCacheStats(): { count: number; totalDuration: number } {
    let totalDuration = 0
    for (const bufferInfo of this.bufferCache.values()) {
      totalDuration += bufferInfo.duration
    }
    return {
      count: this.bufferCache.size,
      totalDuration,
    }
  }
}
