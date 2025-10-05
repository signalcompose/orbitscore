/**
 * SuperCollider-based Audio Player
 * Low-latency audio playback using SuperCollider server
 */

import * as sc from 'supercolliderjs'
import * as fs from 'fs'
import * as path from 'path'

export interface PlayOptions {
  startTime?: number
  volume?: number
  trimStartSeconds?: number
  trimEndSeconds?: number
  pitch?: number
  speed?: number
}

interface ScheduledPlay {
  time: number
  filepath: string
  options: PlayOptions
  sequenceName: string
}

export class SuperColliderPlayer {
  private server: any = null
  private isRunning: boolean = false
  private startTime: number = 0
  private scheduledPlays: ScheduledPlay[] = []
  private sequenceEvents: Map<string, ScheduledPlay[]> = new Map()
  private intervalId?: NodeJS.Timeout
  private bufferCache: Map<string, number> = new Map() // filepath -> bufnum
  private bufferDurations: Map<number, number> = new Map() // bufnum -> duration in seconds
  private nextBufferNum: number = 0
  private synthDefLoaded: boolean = false

  constructor() {}

  /**
   * Boot SuperCollider server and load SynthDef
   */
  async boot(): Promise<void> {
    if (this.server) {
      return
    }

    console.log('🎵 SuperCollider サーバーを起動中...')

    this.server = await sc.server.boot({
      scsynth: '/Applications/SuperCollider.app/Contents/Resources/scsynth',
      debug: false,
    })

    console.log('✅ SuperCollider サーバー起動成功')

    // Load SynthDef
    await this.loadSynthDef()
  }

  /**
   * Load orbitPlayBuf SynthDef
   */
  private async loadSynthDef(): Promise<void> {
    const synthDefPath = path.join(__dirname, '../../supercollider/synthdefs/orbitPlayBuf.scsyndef')
    
    if (!fs.existsSync(synthDefPath)) {
      throw new Error(`SynthDef not found: ${synthDefPath}`)
    }

    const synthDefData = fs.readFileSync(synthDefPath)
    await this.server.send.msg(['/d_recv', synthDefData])
    
    this.synthDefLoaded = true
    console.log('✅ SynthDef ロード完了')
  }

  /**
   * Quit SuperCollider server
   */
  async quit(): Promise<void> {
    if (this.server) {
      await this.server.quit()
      this.server = null
      this.isRunning = false
      this.bufferCache.clear()
      console.log('👋 SuperCollider サーバー終了')
    }
  }

  /**
   * Load audio file into buffer (cached)
   */
  async loadBuffer(filepath: string): Promise<number> {
    // Check cache
    if (this.bufferCache.has(filepath)) {
      return this.bufferCache.get(filepath)!
    }

    // Allocate new buffer
    const bufnum = this.nextBufferNum++
    
    await this.server.send.msg(['/b_allocRead', bufnum, filepath, 0, -1])
    
    // Wait for buffer to load
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // Query buffer info to get duration
    await this.queryBufferDuration(bufnum)
    
    this.bufferCache.set(filepath, bufnum)
    console.log(`📂 バッファ ${bufnum} にロード: ${path.basename(filepath)} (${this.bufferDurations.get(bufnum)?.toFixed(2)}秒)`)
    
    return bufnum
  }

  /**
   * Query buffer duration from SuperCollider
   */
  private async queryBufferDuration(bufnum: number): Promise<void> {
    return new Promise((resolve) => {
      // Listen for /b_info response
      const listener = (msg: any) => {
        if (msg[0] === '/b_info' && msg[1] === bufnum) {
          const numFrames = msg[2]
          const numChannels = msg[3]
          const sampleRate = msg[4]
          const duration = numFrames / sampleRate
          
          this.bufferDurations.set(bufnum, duration)
          
          // Remove listener
          this.server.receive.off(listener)
          resolve()
        }
      }
      
      this.server.receive.on(listener)
      
      // Send query
      this.server.send.msg(['/b_query', bufnum])
      
      // Timeout fallback
      setTimeout(() => {
        this.server.receive.off(listener)
        // Default to 1 second if query fails
        if (!this.bufferDurations.has(bufnum)) {
          this.bufferDurations.set(bufnum, 1.0)
        }
        resolve()
      }, 500)
    })
  }

  /**
   * Schedule audio playback
   */
  playAudio(filepath: string, options: PlayOptions = {}, sequenceName: string = ''): void {
    const startTime = options.startTime || 0

    this.scheduledPlays.push({
      time: startTime,
      filepath,
      options,
      sequenceName,
    })

    // Sort by time to ensure correct playback order
    this.scheduledPlays.sort((a, b) => a.time - b.time)

    // Track sequence events
    if (sequenceName) {
      if (!this.sequenceEvents.has(sequenceName)) {
        this.sequenceEvents.set(sequenceName, [])
      }
      this.sequenceEvents.get(sequenceName)!.push({
        time: startTime,
        filepath,
        options,
        sequenceName,
      })
    }
  }

  /**
   * Execute playback
   */
  private async executePlayback(
    filepath: string,
    options: PlayOptions,
    sequenceName: string,
    scheduledTime: number,
  ): Promise<void> {
    const launchTime = Date.now()
    const actualStartTime = launchTime - this.startTime
    const drift = actualStartTime - scheduledTime

    console.log(`🔊 Playing: ${sequenceName} at ${actualStartTime}ms (scheduled: ${scheduledTime}ms, drift: ${drift}ms)`)

    // Load buffer (cached)
    const bufnum = await this.loadBuffer(filepath)

    const volume = options.volume !== undefined ? options.volume / 100 : 0.5
    const rate = options.speed || 1.0

    // Calculate startPos and duration for chop support
    let startPos = 0
    let duration = 0 // 0 = play entire buffer
    
    if (options.trimStartSeconds !== undefined) {
      startPos = options.trimStartSeconds
      
      // If trim end is specified, calculate duration
      if (options.trimEndSeconds !== undefined) {
        duration = options.trimEndSeconds - options.trimStartSeconds
      } else {
        // Get buffer duration and calculate remaining time
        const bufferDuration = this.bufferDurations.get(bufnum) || 0
        if (bufferDuration > 0) {
          duration = bufferDuration - startPos
        }
      }
    }

    // Send /s_new to play
    await this.server.send.msg([
      '/s_new',
      'orbitPlayBuf',
      -1, // auto-assign node ID
      0,  // add to head
      0,  // default group
      'bufnum', bufnum,
      'amp', volume,
      'rate', rate,
      'startPos', startPos,
      'duration', duration,
    ])
  }

  /**
   * Start scheduler
   */
  startScheduler(): void {
    if (this.isRunning) {
      return
    }

    this.isRunning = true
    this.startTime = Date.now()

    this.scheduledPlays.sort((a, b) => a.time - b.time)

    let lastTick = process.hrtime.bigint()
    this.intervalId = setInterval(() => {
      const tickStart = process.hrtime.bigint()
      const now = Date.now() - this.startTime
      lastTick = tickStart

      while (
        this.scheduledPlays.length > 0 &&
        this.scheduledPlays[0] &&
        this.scheduledPlays[0].time <= now
      ) {
        const play = this.scheduledPlays.shift()!
        this.executePlayback(play.filepath, play.options, play.sequenceName, play.time)
      }
    }, 1) // 1ms precision
  }

  /**
   * Start (alias for startScheduler)
   */
  start(): void {
    if (this.isRunning) {
      this.stop()
    }
    this.startScheduler()
  }

  /**
   * Stop scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
    this.isRunning = false
    console.log('⏹️  Scheduler stopped')
  }

  /**
   * Stop all and clear scheduled plays
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
    this.scheduledPlays = this.scheduledPlays.filter(play => play.sequenceName !== sequenceName)
    this.sequenceEvents.delete(sequenceName)
  }

  /**
   * Schedule event (compatibility method)
   */
  scheduleEvent(
    filepath: string,
    startTimeMs: number,
    volume: number = 80,
    sequenceName: string = '',
  ): void {
    this.playAudio(filepath, { startTime: startTimeMs, volume }, sequenceName)
  }

  /**
   * Schedule slice event (for chop support)
   */
  scheduleSliceEvent(
    filepath: string,
    startTimeMs: number,
    sliceNumber: number,
    totalSlices: number,
    options: PlayOptions = {},
    sequenceName: string = '',
  ): void {
    // Get buffer number (may trigger load)
    const bufnum = this.bufferCache.get(filepath)
    if (bufnum === undefined) {
      console.warn(`⚠️ Buffer not loaded for ${filepath}, will load on playback`)
    }

    // Get duration from cache (or use default)
    const fileDuration = bufnum !== undefined ? (this.bufferDurations.get(bufnum) || 1.0) : 1.0
    const sliceDuration = fileDuration / totalSlices
    const trimStart = (sliceNumber - 1) * sliceDuration
    const trimEnd = sliceNumber * sliceDuration

    console.log(
      `🎵 ${sequenceName} (slice ${sliceNumber}/${totalSlices}: ${trimStart.toFixed(2)}s-${trimEnd.toFixed(2)}s)`,
    )

    const sliceOptions = {
      ...options,
      startTime: startTimeMs,
      trimStartSeconds: trimStart,
      trimEndSeconds: trimEnd,
    }

    this.playAudio(filepath, sliceOptions, sequenceName)
  }

  /**
   * Get audio duration
   */
  getAudioDuration(filepath: string): number {
    const bufnum = this.bufferCache.get(filepath)
    if (bufnum !== undefined) {
      return this.bufferDurations.get(bufnum) || 1.0
    }
    return 1.0
  }
}
