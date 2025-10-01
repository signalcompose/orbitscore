/**
 * Advanced audio player using sox for high-quality playback
 * Supports precise timing, mixing, and effects
 */

import { spawn, ChildProcess, execSync } from 'child_process'

interface PlayOptions {
  startTime?: number // Schedule delay in ms
  volume?: number // 0-100
  trimStart?: number // Start position within file (ms)
  trimEnd?: number // End position within file (ms)
  trimStartSeconds?: number // Start position within file (seconds)
  trimEndSeconds?: number // End position within file (seconds)
  pitch?: number // Pitch shift in semitones
  speed?: number // Playback speed multiplier
}

interface ScheduledPlay {
  time: number
  filepath: string
  options: PlayOptions
  sequenceName: string
}

export class AdvancedAudioPlayer {
  private processes: ChildProcess[] = []
  private scheduledPlays: ScheduledPlay[] = []
  private startTime: number = 0
  private intervalId: NodeJS.Timeout | undefined
  private isRunning: boolean = false
  private hasSox: boolean = false
  private mixerProcess?: ChildProcess

  constructor() {
    this.checkSoxInstallationSync()
  }

  private checkSoxInstallationSync(): void {
    try {
      execSync('which sox', { stdio: 'pipe' })
      this.hasSox = true
      console.log('✅ sox found - advanced audio features enabled')
    } catch {
      this.hasSox = false
      console.warn('⚠️  sox not found. Install with: brew install sox')
    }
  }

  private async checkSoxInstallation(): Promise<void> {
    try {
      const result = spawn('which', ['sox'], { stdio: 'pipe' })

      return new Promise((resolve) => {
        result.on('close', (code) => {
          this.hasSox = code === 0

          if (!this.hasSox) {
            console.warn('')
            console.warn('⚠️  ADVANCED AUDIO FEATURES UNAVAILABLE')
            console.warn('   sox not found. Install with: brew install sox')
            console.warn('   Falling back to afplay (limited features)')
            console.warn('   - No partial playback support')
            console.warn('   - No audio format conversion')
            console.warn('   - No real-time effects')
            console.warn('')
          } else {
            console.log('✅ sox found - advanced audio features enabled')
            console.log('   - Partial playback support')
            console.log('   - Multiple audio formats (WAV, MP3, FLAC, OGG)')
            console.log('   - Real-time effects (pitch, speed, filters)')
          }

          resolve()
        })

        result.on('error', () => {
          this.hasSox = false
          console.warn('⚠️  Error checking sox installation')
          resolve()
        })
      })
    } catch {
      this.hasSox = false
      console.warn('⚠️  Failed to check sox installation')
    }
  }

  /**
   * Play audio with sox or fallback to afplay
   */
  playAudio(filepath: string, options: PlayOptions = {}, sequenceName: string = '') {
    const { startTime = 0 } = options

    // Always schedule through the scheduler for consistent timing
    // This ensures all events use the same time base
    this.scheduledPlays.push({
      time: startTime,
      filepath,
      options: { ...options, startTime: 0 },
      sequenceName,
    })
  }

  /**
   * Execute playback immediately (called by scheduler)
   */
  private executePlayback(
    filepath: string,
    options: PlayOptions,
    sequenceName: string,
    scheduledTime: number,
  ) {
    const {
      volume = 80,
      trimStart,
      trimEnd,
      trimStartSeconds,
      trimEndSeconds,
      pitch = 0,
      speed = 1.0,
    } = options

    const now = Date.now() - this.startTime
    const jitter = now - scheduledTime
    console.log(
      `🕒 executePlayback ${sequenceName} | scheduled=${scheduledTime.toFixed(2)}ms actual=${now.toFixed(2)}ms jitter=${jitter.toFixed(2)}ms`,
    )

    if (this.hasSox) {
      this.playWithSox(
        filepath,
        { volume, trimStart, trimEnd, trimStartSeconds, trimEndSeconds, pitch, speed },
        sequenceName,
        scheduledTime,
      )
    } else {
      this.playWithAfplay(filepath, volume, sequenceName)
    }
  }

  /**
   * Play a specific slice using sox trim (no file slicing needed)
   */
  playSlice(
    filepath: string,
    sliceNumber: number,
    totalSlices: number,
    options: PlayOptions = {},
    sequenceName: string = '',
  ) {
    console.log(
      `🔍 playSlice called: ${sequenceName}, slice ${sliceNumber}/${totalSlices}, hasSox: ${this.hasSox}`,
    )

    if (this.hasSox && totalSlices > 1) {
      // Use sox trim for partial playback - no file slicing needed!
      const duration = this.getAudioDuration(filepath)
      const sliceDuration = duration / totalSlices
      const trimStart = (sliceNumber - 1) * sliceDuration
      const trimEnd = sliceNumber * sliceDuration

      console.log(
        `🎵 ${sequenceName} (sox slice ${sliceNumber}/${totalSlices}: ${trimStart.toFixed(2)}s-${trimEnd.toFixed(2)}s)`,
      )

      const sliceOptions = {
        ...options,
        trimStartSeconds: trimStart, // Use seconds directly
        trimEndSeconds: trimEnd, // Use seconds directly
      }

      this.playAudio(filepath, sliceOptions, sequenceName)
    } else {
      // Fallback to full file playback
      console.log(`🎵 ${sequenceName} (afplay - slice ${sliceNumber}/${totalSlices})`)
      this.playAudio(filepath, options, sequenceName)
    }
  }

  /**
   * Get audio file duration using sox
   */
  private getAudioDuration(filepath: string): number {
    try {
      const result = execSync(`sox --info -D "${filepath}"`, { encoding: 'utf8' })
      const duration = parseFloat(result.trim())
      return duration || 1.0 // Default to 1 second if can't determine
    } catch {
      return 1.0 // Default to 1 second on error
    }
  }

  /**
   * Play with sox for advanced features
   */
  private playWithSox(
    filepath: string,
    options: any,
    sequenceName: string,
    scheduledTime?: number,
  ) {
    const args: string[] = [filepath]

    // Output device
    args.push('-d')

    // Volume (sox uses linear scale)
    if (options.volume !== undefined) {
      const linearVolume = options.volume / 100
      args.push('vol', linearVolume.toString())
    }

    // Trim (partial playback)
    if (options.trimStartSeconds !== undefined || options.trimEndSeconds !== undefined) {
      const start = options.trimStartSeconds || 0
      if (options.trimEndSeconds !== undefined) {
        const duration = options.trimEndSeconds - start
        args.push('trim', start.toString(), duration.toString())
      } else {
        args.push('trim', start.toString())
      }
    }

    // Pitch shift
    if (options.pitch && options.pitch !== 0) {
      args.push('pitch', (options.pitch * 100).toString()) // sox uses cents
    }

    // Speed change
    if (options.speed && options.speed !== 1.0) {
      args.push('speed', options.speed.toString())
    }

    // Debug: log the sox command
    console.log(`🔧 sox command: sox ${args.join(' ')}`)

    const launchTime = Date.now()
    const proc = spawn('sox', args, {
      stdio: 'ignore',
      detached: false,
    })

    console.log(
      `🚀 sox spawn ${sequenceName} | scheduled=${
        scheduledTime !== undefined ? scheduledTime.toFixed(2) : 'n/a'
      }ms launchDelta=${this.isRunning ? (launchTime - this.startTime).toFixed(2) : 'n/a'}ms`,
    )

    proc.on('error', (err) => {
      console.error(`sox error for ${sequenceName}:`, err.message)
    })

    proc.on('close', (code) => {
      const closeTime = Date.now()
      console.log(
        `✅ sox close ${sequenceName} | exit=${code} elapsed=${
          scheduledTime !== undefined && this.isRunning
            ? (closeTime - (this.startTime + scheduledTime)).toFixed(2)
            : 'n/a'
        }ms`,
      )
    })

    this.processes.push(proc)
    console.log(`🎵 ${sequenceName} (sox)`)
  }

  /**
   * Fallback to afplay
   */
  private playWithAfplay(filepath: string, volume: number, sequenceName: string) {
    const args = [filepath]

    if (volume !== undefined) {
      args.push('-v', (volume / 100).toString())
    }

    const proc = spawn('afplay', args, {
      stdio: 'ignore',
      detached: false,
    })

    proc.on('error', (err) => {
      console.error(`afplay error for ${sequenceName}:`, err.message)
    })

    this.processes.push(proc)
    console.log(`🎵 ${sequenceName} (afplay)`)
  }

  /**
   * Start the scheduler
   */
  startScheduler() {
    if (this.isRunning) return

    this.isRunning = true
    this.startTime = Date.now()

    // Sort scheduled plays by time
    this.scheduledPlays.sort((a, b) => a.time - b.time)

    console.log(`🎬 Starting advanced scheduler with ${this.scheduledPlays.length} events`)

    // High-precision scheduling loop
    let lastTick = process.hrtime.bigint()
    this.intervalId = setInterval(() => {
      const tickStart = process.hrtime.bigint()
      const now = Date.now() - this.startTime
      const intervalNs = Number(tickStart - lastTick) / 1_000_000
      lastTick = tickStart
      console.log(
        `🌀 scheduler tick | now=${now.toFixed(2)}ms interval=${intervalNs.toFixed(2)}ms queue=${this.scheduledPlays.length}`,
      )

      while (
        this.scheduledPlays.length > 0 &&
        this.scheduledPlays[0] &&
        this.scheduledPlays[0].time <= now
      ) {
        const play = this.scheduledPlays.shift()!
        console.log(
          `⏰ Playing at ${now}ms (scheduled: ${play.time}ms, remaining: ${this.scheduledPlays.length})`,
        )
        this.executePlayback(play.filepath, play.options, play.sequenceName, play.time)
      }

      // Stop if no more events
      if (this.scheduledPlays.length === 0 && this.intervalId !== undefined) {
        console.log(`🛑 No more events, stopping in 1s`)
        setTimeout(() => this.stop(), 1000) // Wait 1s then stop
      }
    }, 1) // 1ms precision
  }

  /**
   * Stop scheduler and all audio
   */
  stop() {
    if (!this.isRunning) return

    this.isRunning = false

    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }

    console.log('🛑 Advanced scheduler stopped')
  }

  /**
   * Kill all playing processes
   */
  stopAll() {
    this.stop()

    for (const proc of this.processes) {
      if (proc && !proc.killed) {
        proc.kill()
      }
    }

    this.processes = []
    this.scheduledPlays = []
  }

  /**
   * Schedule an event (compatibility with PrecisionScheduler)
   */
  scheduleEvent(
    filepath: string,
    startTimeMs: number,
    volume: number = 80,
    sequenceName: string = '',
  ) {
    this.playAudio(filepath, { startTime: startTimeMs, volume }, sequenceName)
  }

  /**
   * Schedule a slice event (sox partial playback)
   */
  scheduleSliceEvent(
    filepath: string,
    startTimeMs: number,
    sliceNumber: number,
    totalSlices: number,
    options: PlayOptions = {},
    sequenceName: string = '',
  ) {
    if (this.hasSox && totalSlices > 1) {
      // Use sox trim for partial playback - no file slicing needed!
      const duration = this.getAudioDuration(filepath)
      const sliceDuration = duration / totalSlices
      const trimStart = (sliceNumber - 1) * sliceDuration
      const trimEnd = sliceNumber * sliceDuration

      console.log(
        `🎵 ${sequenceName} (sox slice ${sliceNumber}/${totalSlices}: ${trimStart.toFixed(2)}s-${trimEnd.toFixed(2)}s)`,
      )

      const sliceOptions = {
        ...options,
        startTime: startTimeMs,
        trimStartSeconds: trimStart,
        trimEndSeconds: trimEnd,
      }

      this.playAudio(filepath, sliceOptions, sequenceName)
    } else {
      // Fallback to full file playback
      console.log(`🎵 ${sequenceName} (afplay - slice ${sliceNumber}/${totalSlices})`)
      this.playAudio(filepath, { ...options, startTime: startTimeMs }, sequenceName)
    }
  }

  /**
   * Start playback (compatibility)
   */
  start() {
    this.startScheduler()
  }
}
