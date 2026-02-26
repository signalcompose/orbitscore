/**
 * SuperCollider OSC通信クライアント
 */

import * as sc from 'supercolliderjs'

import { BootOptions, AudioDevice } from './types'

export class OSCClient {
  private server: any = null
  private availableDevices: AudioDevice[] = []
  private currentOutputDevice: string | null = null

  /**
   * SuperColliderサーバーを起動
   */
  async boot(outputDevice?: string, options?: BootOptions): Promise<void> {
    console.log('🎵 Booting SuperCollider server...')

    const bootOptions: any = {
      scsynth: '/Applications/SuperCollider.app/Contents/Resources/scsynth',
      debug: false,
      ...options,
    }

    // Set output device if specified (by name)
    if (outputDevice) {
      bootOptions.device = outputDevice
      this.currentOutputDevice = outputDevice
      console.log(`🔊 Using output device: ${outputDevice}`)
    }

    // @ts-expect-error - supercolliderjs types are incomplete
    this.server = await sc.server.boot(bootOptions)

    console.log('✅ SuperCollider server ready')
  }

  /**
   * OSCメッセージを送信
   */
  async sendMessage(message: any[]): Promise<void> {
    if (!this.server) {
      throw new Error('SuperCollider server not running')
    }
    await this.server.send.msg(message)
  }

  /**
   * バッファロードコマンドを送信し、/doneメッセージを待つ
   */
  async sendBufferLoad(bufnum: number, filepath: string): Promise<void> {
    if (!this.server) {
      throw new Error('SuperCollider server not running')
    }
    // Use callAndResponse to wait for /done message
    await this.server.callAndResponse({
      call: ['/b_allocRead', bufnum, filepath, 0, -1],
      response: ['/done', '/b_allocRead', bufnum],
    })
  }

  /**
   * サーバーが起動しているかチェック
   */
  isRunning(): boolean {
    return this.server !== null
  }

  /**
   * サーバーを終了
   */
  async quit(): Promise<void> {
    if (this.server) {
      await this.server.quit()
      this.server = null
      console.log('👋 SuperCollider server quit')
    }
  }

  /**
   * 利用可能なオーディオデバイスを取得
   */
  getAvailableDevices(): AudioDevice[] {
    return this.availableDevices
  }

  /**
   * 現在の出力デバイス名を取得
   */
  getCurrentOutputDevice(): string | null {
    return this.currentOutputDevice
  }

  /**
   * 利用可能なデバイスを設定（起動プロセス中に呼び出される）
   */
  setAvailableDevices(devices: AudioDevice[]): void {
    this.availableDevices = devices
  }
}
