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
  private sequenceEvents: Map<string, ScheduledPlay[]> = new Map() // Track events per sequence
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
    } catch {
      this.hasSox = false
      console.warn('⚠️ sox not found')
    }
  }

  private async checkSoxInstallation(): Promise<void> {
    try {
      const result = spawn('which', ['sox'], { stdio: 'pipe' })

      return new Promise((resolve) => {
        result.on('close', (code) => {
          this.hasSox = code === 0

          if (!this.hasSox) {
            console.warn('⚠️ sox not found - limited features')
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
    
    // Re-sort after adding new event to maintain time order
    this.scheduledPlays.sort((a, b) => a.time - b.time)
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
    const launchTime = Date.now()
    const actualStartTime = launchTime - this.startTime
    const drift = actualStartTime - scheduledTime

    // Log actual playback timing
    console.log(`🔊 Playing: ${sequenceName} at ${actualStartTime}ms (scheduled: ${scheduledTime}ms, drift: ${drift}ms)`)

    const {
      volume = 80,
      trimStart,
      trimEnd,
      trimStartSeconds,
      trimEndSeconds,
      pitch = 0,
      speed = 1.0,
    } = options

    // executePlayback

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
    // playSlice

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

    const launchTime = Date.now()
    const proc = spawn('sox', args, {
      stdio: ['ignore', 'ignore', 'pipe'], // Ignore stdout, capture stderr only for real errors
      detached: false,
    })

    // Capture stderr for real errors only
    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        const errorMsg = data.toString().trim()
        // Only show actual errors (FAIL, ERROR), ignore info/warnings
        if (errorMsg && (errorMsg.includes('FAIL') || errorMsg.includes('ERROR'))) {
          console.error(`sox error: ${errorMsg}`)
        }
      })
    }

    proc.on('error', (err) => {
      console.error(`sox error for ${sequenceName}:`, err.message)
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`sox ${sequenceName}: exit=${code}`)
      }
    })

    this.processes.push(proc)
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
  }

  /**
   * Start the scheduler
   */
  startScheduler() {
    if (this.isRunning) {
      return
    }

    this.isRunning = true
    this.startTime = Date.now()

    // Sort scheduled plays by time
    this.scheduledPlays.sort((a, b) => a.time - b.time)

    // High-precision scheduling loop
    let lastTick = process.hrtime.bigint()
    this.intervalId = setInterval(() => {
      const tickStart = process.hrtime.bigint()
      const now = Date.now() - this.startTime
      const intervalNs = Number(tickStart - lastTick) / 1_000_000
      lastTick = tickStart

      while (
        this.scheduledPlays.length > 0 &&
        this.scheduledPlays[0] &&
        this.scheduledPlays[0].time <= now
      ) {
        const play = this.scheduledPlays.shift()!
        this.executePlayback(play.filepath, play.options, play.sequenceName, play.time)
      }

      // Don't auto-stop in live coding mode
      // The scheduler should keep running even when queue is empty
      // to allow new events to be added dynamically
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
    this.sequenceEvents.clear() // Clear all sequence events
  }

  /**
   * Clear all events for a specific sequence
   */
  clearSequenceEvents(sequenceName: string) {
    // Remove from main queue
    this.scheduledPlays = this.scheduledPlays.filter(play => play.sequenceName !== sequenceName)
    
    // Clear from sequence tracking
    this.sequenceEvents.delete(sequenceName)
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
    // Note: Scheduler must be started explicitly with global.run()
    // This ensures explicit control over when audio playback begins
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
    // Note: Scheduler must be started explicitly with global.run()
    // This ensures explicit control over when audio playback begins
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
    // Force restart to ensure clean startTime
    if (this.isRunning) {
      this.stop()
    }
    this.startScheduler()
  }
}
