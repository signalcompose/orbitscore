/**
 * SuperCollider OSC通信クライアント
 */

import * as sc from 'supercolliderjs'

import { BootOptions, AudioDevice } from './types'

/**
 * Sentinel marking a `registerLinkAudioChannel` rejection as OUR registration
 * timeout (no `/done` arrived in time) — which is how plugin absence presents.
 * Distinct from a transport error (socket closed / server crash): the caller
 * latches `linkAudioPluginAvailable=false` only on this sentinel, never on a
 * transport error (which it re-probes instead).
 */
class LinkAudioRegisterTimeoutError extends Error {
  constructor() {
    super('registerLinkAudioChannel timeout')
    this.name = 'LinkAudioRegisterTimeoutError'
  }
}

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
   * Returns `true` on `/done` and `false` on OUR registration timeout — the
   * timeout doubles as plugin-presence detection: if the OrbitLinkAudio plugin
   * is not loaded, nothing replies and the caller falls back to the hardware bus
   * and latches the absence. A genuine transport error (socket closed / server
   * crash) is NOT a timeout, so it is rethrown rather than mapped to `false`;
   * the caller treats a rethrow as transient and re-probes later instead of
   * permanently latching the plugin as absent.
   *
   * Our manual `timeoutMs` (2000) is shorter than supercolliderjs's own
   * `callAndResponse` timeout (4000ms), so a plugin-absent no-reply always
   * settles via our sentinel first.
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
          timer = setTimeout(() => reject(new LinkAudioRegisterTimeoutError()), timeoutMs)
        }),
      ])
      return true
    } catch (err) {
      // Our registration timeout → plugin absent; caller falls back + latches.
      if (err instanceof LinkAudioRegisterTimeoutError) {
        return false
      }
      // Transport error (socket closed / server crash) → not plugin-absence.
      // Rethrow so the caller can treat it as transient and re-probe later
      // rather than permanently latching `linkAudioPluginAvailable=false`.
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Start the persistent keepalive synth for a LinkAudio channel (#209).
   *
   * LinkAudio is a CONTINUOUS audio stream. A transient `orbitPlayBufLink` synth
   * only commits while its sample plays, so a sparse pattern (0.5s hit / 1.5s
   * gap) leaves holes in the stream → the receiver underruns (level drift at low
   * latency) or plays the holes (choppy at high latency). This synth commits
   * silence every audio block for the channel's lifetime, keeping the stream
   * unbroken; sample synths sum their audio on top via the plugin's per-channel
   * mix accumulator. Added at the group tail; one per channel.
   */
  async startLinkAudioKeepalive(channelId: number, nodeId: number): Promise<void> {
    if (!this.server) {
      throw new Error('SuperCollider server not running')
    }
    await this.sendMessage([
      '/s_new',
      'orbitLinkAudioKeepalive',
      nodeId,
      1, // addToTail
      0, // target group
      'channel',
      channelId,
    ])
  }

  /** Free a node by id — used to stop keepalive synths on engine restart. */
  async freeNode(nodeId: number): Promise<void> {
    if (!this.server) {
      return
    }
    await this.sendMessage(['/n_free', nodeId])
  }

  /**
   * Push a tempo to the Link session via the OrbitLinkAudio plugin (#283).
   *
   * Sends `/cmd /orbit/setLinkTempo <bpm>` so the plugin makes OrbitScore the
   * Link tempo leader — connected peers (Ableton Live, etc.) follow this BPM.
   * Best-effort and fire-and-forget: no `/done` is awaited (tempo leadership is
   * advisory, and the plugin handles or ignores the command depending on
   * presence). No-op when the server is not running. The `/cmd` is harmless if
   * the plugin is absent (scsynth logs an unknown-command notice at most).
   */
  async setLinkTempo(bpm: number): Promise<void> {
    if (!this.server) {
      return
    }
    await this.sendMessage(['/cmd', '/orbit/setLinkTempo', bpm])
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
