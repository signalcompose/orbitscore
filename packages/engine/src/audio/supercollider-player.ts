import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

import * as sc from 'supercolliderjs'

interface BufferInfo {
  bufnum: number
  duration: number
}

interface ScheduledPlay {
  time: number
  filepath: string
  options: {
    gainDb?: number // Gain in dB (-60 to +12, default 0)
    pan?: number // Pan position (-100 to +100, default 0)
    startPos?: number // Start position in seconds
    duration?: number // Duration in seconds
    rate?: number // Playback rate (1.0 = normal, 2.0 = double speed, 0.5 = half speed)
  }
  sequenceName: string
}

export interface AudioDevice {
  id: number
  name: string
  type: 'input' | 'output'
  channels: number
}

/**
 * SuperCollider audio player with low-latency scheduling
 */
export class SuperColliderPlayer {
  private server: any = null
  private bufferCache: Map<string, BufferInfo> = new Map()
  private bufferDurations: Map<number, number> = new Map()
  private nextBufnum = 0
  private synthDefPath: string
  private availableDevices: AudioDevice[] = []
  private currentOutputDevice: string | null = null
  private effectSynths: Map<string, Map<string, number>> = new Map() // Track mastering effect synths by target and type

  // Scheduler
  public isRunning = false
  private startTime = 0
  private scheduledPlays: ScheduledPlay[] = []
  private sequenceEvents: Map<string, ScheduledPlay[]> = new Map()
  private intervalId: NodeJS.Timeout | null = null

  constructor() {
    // __dirname is available in CommonJS context
    this.synthDefPath = path.join(__dirname, '../../supercollider/synthdefs/orbitPlayBuf.scsyndef')
  }

  /**
   * Boot SuperCollider server and load SynthDef
   */
  async boot(outputDevice?: string): Promise<void> {
    console.log('🎵 Booting SuperCollider server...')

    const bootOptions: any = {
      scsynth: '/Applications/SuperCollider.app/Contents/Resources/scsynth',
      debug: false,
    }

    // Set output device if specified (by name)
    // SuperCollider device option can be a string or [inputDevice, outputDevice] array
    if (outputDevice) {
      // Use array format: [inputDevice, outputDevice]
      // Use default input device (MacBook Airの) and specified output
      bootOptions.device = ['MacBook Airの', outputDevice]
      this.currentOutputDevice = outputDevice
      console.log(`🔊 Using output device: ${outputDevice}`)
    }

    // @ts-expect-error - supercolliderjs types are incomplete
    this.server = await sc.server.boot(bootOptions)

    console.log('✅ SuperCollider server ready')

    // Parse available devices from server boot log
    // Note: Device list is printed during boot, we'll capture it from stdout

    // Load SynthDef
    const synthDefData = fs.readFileSync(this.synthDefPath)
    await this.server.send.msg(['/d_recv', synthDefData])

    // Wait for SynthDef to be ready
    await new Promise((resolve) => setTimeout(resolve, 200))

    console.log('✅ SynthDef loaded')

    // Load mastering effect SynthDefs
    await this.loadMasteringEffectSynthDefs()
  }

  /**
   * Load mastering effect SynthDefs
   */
  private async loadMasteringEffectSynthDefs(): Promise<void> {
    if (!this.server) {
      return
    }

    const synthDefDir = path.join(__dirname, '../../supercollider/synthdefs')
    const effectSynthDefs = ['fxCompressor', 'fxLimiter', 'fxNormalizer']

    for (const synthDefName of effectSynthDefs) {
      const synthDefPath = path.join(synthDefDir, `${synthDefName}.scsyndef`)
      if (fs.existsSync(synthDefPath)) {
        const synthDefData = fs.readFileSync(synthDefPath)
        await this.server.send.msg(['/d_recv', synthDefData])
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    console.log('✅ Mastering effect SynthDefs loaded')
  }

  /**
   * Get list of available audio devices
   * Note: This information is captured during server boot
   */
  getAvailableDevices(): AudioDevice[] {
    return this.availableDevices
  }

  /**
   * Get current output device name
   */
  getCurrentOutputDevice(): string | null {
    return this.currentOutputDevice
  }

  /**
   * Set available devices (called during boot process)
   */
  setAvailableDevices(devices: AudioDevice[]): void {
    this.availableDevices = devices
  }

  /**
   * Load audio file into buffer
   */
  async loadBuffer(filepath: string): Promise<BufferInfo> {
    if (this.bufferCache.has(filepath)) {
      return this.bufferCache.get(filepath)!
    }

    const bufnum = this.nextBufnum++

    // Get duration from audio file using sox before loading into SuperCollider
    const duration = this.getAudioFileDuration(filepath)

    await this.server.send.msg(['/b_allocRead', bufnum, filepath, 0, -1])

    const bufferInfo: BufferInfo = { bufnum, duration }
    this.bufferCache.set(filepath, bufferInfo)
    this.bufferDurations.set(bufnum, duration)

    console.log(`📦 Loaded buffer ${bufnum} (${path.basename(filepath)}): ${duration.toFixed(3)}s`)

    return bufferInfo
  }

  /**
   * Get audio file duration using sox
   */
  private getAudioFileDuration(filepath: string): number {
    try {
      // Use sox to get audio file duration
      const output = execSync(`soxi -D "${filepath}"`, { encoding: 'utf8' })
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
   * Get audio duration from cache
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
   * Schedule a play event
   */
  scheduleEvent(
    filepath: string,
    startTimeMs: number,
    gainDb = 0,
    pan = 0,
    sequenceName = '',
  ): void {
    const play: ScheduledPlay = {
      time: startTimeMs,
      filepath,
      options: { gainDb, pan },
      sequenceName,
    }

    this.scheduledPlays.push(play)
    this.scheduledPlays.sort((a, b) => a.time - b.time)

    // Track sequence events
    if (sequenceName) {
      if (!this.sequenceEvents.has(sequenceName)) {
        this.sequenceEvents.set(sequenceName, [])
      }
      this.sequenceEvents.get(sequenceName)!.push(play)
    }
  }

  /**
   * Schedule a slice event (for chop)
   */
  scheduleSliceEvent(
    filepath: string,
    startTimeMs: number,
    sliceIndex: number,
    totalSlices: number,
    eventDurationMs: number,
    gainDb = 0,
    pan = 0,
    sequenceName = '',
  ): void {
    const duration = this.getAudioDuration(filepath)
    const sliceDuration = duration / totalSlices
    // sliceIndex is 1-based from DSL, convert to 0-based
    const startPos = (sliceIndex - 1) * sliceDuration

    // Calculate playback rate to fit slice into event duration
    // rate = actual slice duration / desired event duration
    // If slice is shorter than event, we need to slow down (rate < 1.0) to stretch it
    // If slice is longer than event, we need to speed up (rate > 1.0) to compress it
    // Use milliseconds to maintain precision, then convert
    const rate = (sliceDuration * 1000) / eventDurationMs

    const play: ScheduledPlay = {
      time: startTimeMs,
      filepath,
      options: {
        gainDb,
        pan,
        startPos,
        duration: sliceDuration,
        rate,
      },
      sequenceName,
    }

    this.scheduledPlays.push(play)
    this.scheduledPlays.sort((a, b) => a.time - b.time)

    // Track sequence events
    if (sequenceName) {
      if (!this.sequenceEvents.has(sequenceName)) {
        this.sequenceEvents.set(sequenceName, [])
      }
      this.sequenceEvents.get(sequenceName)!.push(play)
    }
  }

  /**
   * Execute playback
   */
  private async executePlayback(
    filepath: string,
    options: { gainDb?: number; pan?: number; startPos?: number; duration?: number; rate?: number },
    sequenceName: string,
    scheduledTime: number,
  ): Promise<void> {
    const launchTime = Date.now()
    const actualStartTime = launchTime - this.startTime
    const drift = actualStartTime - scheduledTime

    if ((globalThis as any).ORBITSCORE_DEBUG) {
      console.log(
        `🔊 Playing: ${sequenceName} at ${actualStartTime}ms (scheduled: ${scheduledTime}ms, drift: ${drift}ms)`,
      )
    }

    const { bufnum } = await this.loadBuffer(filepath)

    // Convert dB to amplitude: amplitude = 10^(dB/20)
    // Default: 0 dB = 1.0 (100%)
    let amplitude: number
    if (options.gainDb === undefined) {
      amplitude = 1.0 // 0 dB default
    } else if (options.gainDb === -Infinity) {
      amplitude = 0.0 // Complete silence
    } else {
      amplitude = Math.pow(10, options.gainDb / 20)
    }

    const pan = options.pan !== undefined ? options.pan / 100 : 0.0 // -100..100 -> -1.0..1.0
    const startPos = options.startPos ?? 0
    const duration = options.duration ?? 0
    const rate = options.rate ?? 1.0

    await this.server.send.msg([
      '/s_new',
      'orbitPlayBuf',
      -1,
      0,
      0,
      'bufnum',
      bufnum,
      'amp',
      amplitude,
      'pan',
      pan,
      'rate',
      rate,
      'startPos',
      startPos,
      'duration',
      duration,
    ])
  }

  /**
   * Start scheduler
   */
  start(): void {
    if (this.isRunning) {
      return
    }

    this.isRunning = true
    this.startTime = Date.now()

    console.log('✅ Global running')

    this.scheduledPlays.sort((a, b) => a.time - b.time)

    this.intervalId = setInterval(() => {
      const now = Date.now() - this.startTime

      while (this.scheduledPlays.length > 0 && this.scheduledPlays[0].time <= now) {
        const play = this.scheduledPlays.shift()!
        this.executePlayback(play.filepath, play.options, play.sequenceName, play.time)
      }
    }, 1)
  }

  /**
   * Stop scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.isRunning = false
    console.log('✅ Global stopped')
  }

  /**
   * Stop all and clear events
   */
  stopAll(): void {
    this.stop()
    this.scheduledPlays = []
    this.sequenceEvents.clear()
  }

  /**
   * Clear events for a specific sequence
   */
  clearSequenceEvents(sequenceName: string): void {
    const beforeCount = this.scheduledPlays.length
    this.scheduledPlays = this.scheduledPlays.filter((play) => play.sequenceName !== sequenceName)
    const afterCount = this.scheduledPlays.length
    const cleared = beforeCount - afterCount
    if (cleared > 0) {
      console.log(`🗑️  Cleared ${cleared} events for ${sequenceName} (${afterCount} remaining)`)
    }
    this.sequenceEvents.delete(sequenceName)
  }

  /**
   * Add mastering effect to master output
   */
  async addEffect(target: string, effectType: string, params: any): Promise<void> {
    if (!this.server) {
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

        await this.server.send.msg(setParams)
        console.log(`✅ ${effectType} updated`)
      } else {
        // Create new effect synth
        const synthId = Math.floor(Math.random() * 1000000) + 1000
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

        await this.server.send.msg(createParams)

        // Store synth ID by effect type
        targetEffects.set(effectType, synthId)

        console.log(`✅ ${effectType} created (ID: ${synthId})`)
      }
    } catch (error) {
      console.error(`⚠️  Failed to add ${effectType}:`, error)
    }
  }

  /**
   * Remove effect from master output
   */
  async removeEffect(target: string, effectType: string): Promise<void> {
    if (!this.server) {
      return
    }

    const targetEffects = this.effectSynths.get(target)
    if (targetEffects) {
      const synthId = targetEffects.get(effectType)
      if (synthId !== undefined) {
        try {
          await this.server.send.msg(['/n_free', synthId])
          targetEffects.delete(effectType)
          console.log(`✅ ${effectType} removed (ID: ${synthId})`)
        } catch (error) {
          console.error(`⚠️  Failed to free synth:`, error)
        }
      }
    }
  }

  /**
   * Quit SuperCollider server
   */
  async quit(): Promise<void> {
    if (this.server) {
      this.stop()
      await this.server.quit()
      console.log('👋 SuperCollider server quit')
    }
  }
}
