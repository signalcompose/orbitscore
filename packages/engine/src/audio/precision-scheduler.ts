/**
 * High-precision audio scheduler for accurate timing
 * Uses Web Audio API-style scheduling with lookahead
 */

import { spawn } from 'child_process'
import * as path from 'path'

interface ScheduledEvent {
  time: number // absolute time in ms
  filepath: string
  volume: number
  sequenceName: string
}

export class PrecisionScheduler {
  private events: ScheduledEvent[] = []
  private startTime: number = 0
  private isRunning: boolean = false
  private scheduleAheadTime: number = 100 // Schedule events 100ms in advance
  private lookAheadInterval: number = 25 // Check every 25ms
  private intervalId: NodeJS.Timeout | undefined
  private lastScheduledTime: number = 0
  private processes: any[] = []

  /**
   * Add an event to the schedule
   */
  scheduleEvent(
    filepath: string,
    startTimeMs: number,
    volume: number = 80,
    sequenceName: string = '',
  ) {
    this.events.push({
      time: startTimeMs,
      filepath: path.resolve(filepath),
      volume,
      sequenceName,
    })
  }

  /**
   * Start the scheduler with high-precision timing
   */
  start() {
    if (this.isRunning) return

    this.isRunning = true
    this.startTime = Date.now()
    this.lastScheduledTime = 0

    // Sort events by time
    this.events.sort((a, b) => a.time - b.time)

    console.log(`🎬 Starting precision scheduler with ${this.events.length} events`)

    // Start the scheduling loop
    this.intervalId = setInterval(() => this.schedule(), this.lookAheadInterval)

    // Initial schedule
    this.schedule()
  }

  /**
   * The main scheduling loop
   */
  private schedule() {
    if (!this.isRunning) return

    const currentTime = Date.now() - this.startTime
    const scheduleUntil = currentTime + this.scheduleAheadTime

    // Schedule all events that fall within the lookahead window
    while (this.events.length > 0 && this.events[0] && this.events[0].time < scheduleUntil) {
      const event = this.events.shift()!

      // Calculate when to actually play this sound
      const delayMs = Math.max(0, event.time - currentTime)

      // Schedule the sound to play
      this.playSound(event, delayMs)
    }

    // Stop scheduler if no more events and enough time has passed
    if (this.events.length === 0 && currentTime > this.lastScheduledTime + 1000) {
      this.stop()
    }
  }

  /**
   * Play a sound with precise timing
   */
  private playSound(event: ScheduledEvent, delayMs: number) {
    // Use setImmediate for delays less than 10ms for better accuracy
    const playFunc = () => {
      const actualTime = Date.now() - this.startTime
      const drift = actualTime - event.time

      // Only log if drift is significant (> 5ms)
      if (Math.abs(drift) > 5) {
        console.log(
          `⚠️  ${event.sequenceName} @ ${event.time}ms (drift: ${drift > 0 ? '+' : ''}${drift}ms)`,
        )
      } else {
        console.log(`🎵 ${event.sequenceName} @ ${actualTime}ms`)
      }

      // Play the sound using afplay
      if (process.platform === 'darwin') {
        const volumeArg = (event.volume / 100).toString()
        const proc = spawn('afplay', ['-v', volumeArg, event.filepath], {
          detached: false,
          stdio: 'ignore',
        })
        this.processes.push(proc)
      }
    }

    this.lastScheduledTime = event.time

    if (delayMs < 10) {
      // For very short delays, use setImmediate
      setImmediate(playFunc)
    } else {
      // For longer delays, use setTimeout with high-resolution timing
      setTimeout(playFunc, delayMs)
    }
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (!this.isRunning) return

    this.isRunning = false

    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }

    console.log('🛑 Scheduler stopped')
  }

  /**
   * Stop all sounds and clear the schedule
   */
  stopAll() {
    this.stop()
    this.events = []

    // Kill all playing processes
    for (const proc of this.processes) {
      if (proc && !proc.killed) {
        proc.kill()
      }
    }
    this.processes = []
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      eventsRemaining: this.events.length,
      currentTime: this.isRunning ? Date.now() - this.startTime : 0,
    }
  }
}
