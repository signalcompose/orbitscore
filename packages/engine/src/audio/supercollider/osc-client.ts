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
   * SuperColliderサーバーを起動。
   *
   * `BootOptions.scsynth` は caller (`SuperColliderPlayer.boot()` 等) で
   * `resolveScsynthPath()` を通して必ず埋めること。本メソッドは hardcode を持たず、
   * 未指定時は明示エラーを投げる。
   */
  async boot(outputDevice?: string, options?: BootOptions): Promise<void> {
    console.log('🎵 Booting SuperCollider server...')

    const bootOptions: any = {
      debug: false,
      ...options,
    }

    if (!bootOptions.scsynth) {
      throw new Error(
        'OSCClient.boot: BootOptions.scsynth is required. Caller must resolve scsynth path (see scsynth-resolver.ts).',
      )
    }

    // Set output device if specified (by name)
    // device maps to scsynth -H flag, numInputBusChannels maps to -i flag
    // Output-only devices (e.g. "外部") need -i 0 to disable input channels
    // Note: supercolliderjs args() only accepts string values (_.isString check)
    if (outputDevice) {
      bootOptions.device = outputDevice
      bootOptions.numInputBusChannels = '0'
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
   * Register a LinkAudio channel name with the OrbitLinkAudio plugin (#209).
   *
   * Sends `/cmd /orbit/registerLinkAudioChannel <channelId> <name>` so the
   * plugin has a sink for `orbitPlayBufLink` synths dispatched on `channelId`,
   * and waits for the plugin's `/done /orbit/registerLinkAudioChannel` reply.
   *
   * Returns `true` on `/done`, `false` on timeout. The timeout doubles as
   * plugin-presence detection: if the OrbitLinkAudio plugin is not loaded,
   * nothing replies and we fall back to the hardware bus.
   */
  async registerLinkAudioChannel(
    channelId: number,
    name: string,
    timeoutMs = 2000,
  ): Promise<boolean> {
    if (!this.server) {
      throw new Error('SuperCollider server not running')
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.server.callAndResponse({
          call: ['/cmd', '/orbit/registerLinkAudioChannel', channelId, name],
          response: ['/done', '/orbit/registerLinkAudioChannel'],
        }),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('registerLinkAudioChannel timeout')), timeoutMs)
        }),
      ])
      return true
    } catch {
      // Timeout or transport error → treat as plugin-absent; caller falls back.
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
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
