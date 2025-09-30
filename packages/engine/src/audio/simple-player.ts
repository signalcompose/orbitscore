/**
 * Simple audio player using system commands
 * For testing actual sound output
 */

import { spawn } from 'child_process'
import * as path from 'path'

export class SimpleAudioPlayer {
  private isPlaying = false
  private processes: any[] = []
  private scheduledEvents: { time: number; callback: () => void }[] = []
  private startTime: number = 0
  private intervalId: NodeJS.Timeout | undefined

  /**
   * Play a WAV file using system command
   */
  async playFile(
    filepath: string,
    options: {
      volume?: number // 0-100
      startTime?: number // Delay in ms
    } = {},
  ) {
    const fullPath = path.resolve(filepath)

    // On macOS, use afplay
    if (process.platform === 'darwin') {
      const volumeArg = options.volume !== undefined ? `-v ${options.volume / 100}` : ''

      const play = () => {
        try {
          console.log(`🔊 Playing: ${path.basename(filepath)} at ${Date.now() - this.startTime}ms`)
          const proc = spawn('afplay', [volumeArg, fullPath].filter(Boolean), {
            detached: false,
            stdio: 'ignore',
          })
          this.processes.push(proc)
        } catch (error) {
          console.error(`Failed to play ${filepath}:`, error)
        }
      }

      if (options.startTime !== undefined && options.startTime > 0) {
        // Schedule for later
        this.scheduledEvents.push({
          time: options.startTime,
          callback: play,
        })
      } else {
        // Play immediately
        play()
      }
    } else {
      console.warn('Audio playback only supported on macOS currently')
    }
  }

  /**
   * Start the scheduler for accurate timing
   */
  startScheduler() {
    this.startTime = Date.now()
    this.scheduledEvents.sort((a, b) => a.time - b.time)

    // Use high-precision scheduling
    this.intervalId = setInterval(() => {
      const now = Date.now() - this.startTime

      // Execute all events that should have fired by now
      while (
        this.scheduledEvents.length > 0 &&
        this.scheduledEvents[0] &&
        this.scheduledEvents[0].time <= now
      ) {
        const event = this.scheduledEvents.shift()!
        event.callback()
      }

      // Stop scheduler if no more events
      if (this.scheduledEvents.length === 0 && this.intervalId !== undefined) {
        clearInterval(this.intervalId)
        this.intervalId = undefined
      }
    }, 1) // Check every 1ms for better timing accuracy
  }

  /**
   * Stop all playing audio
   */
  stopAll() {
    for (const proc of this.processes) {
      if (proc && !proc.killed) {
        proc.kill()
      }
    }
    this.processes = []
    this.scheduledEvents = []
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
  }

  /**
   * Play a simple drum pattern for testing
   */
  async playDrumPattern(bpm: number = 120) {
    const beatDuration = 60000 / bpm // ms per beat

    console.log(`🥁 Playing drum pattern at ${bpm} BPM`)
    console.log('   Kick:  [1, 0, 1, 0]')
    console.log('   Snare: [0, 1, 0, 1]')
    console.log('   HiHat: [1, 1, 1, 1]')

    // Play 4 bars
    for (let bar = 0; bar < 4; bar++) {
      const barOffset = bar * beatDuration * 4

      // Schedule drums for this bar
      for (let beat = 0; beat < 4; beat++) {
        const beatOffset = barOffset + beat * beatDuration

        // Kick on beats 1 and 3
        if (beat === 0 || beat === 2) {
          this.playFile('../../test-assets/audio/kick.wav', {
            startTime: beatOffset,
            volume: 80,
          })
        }

        // Snare on beats 2 and 4
        if (beat === 1 || beat === 3) {
          this.playFile('../../test-assets/audio/snare.wav', {
            startTime: beatOffset,
            volume: 70,
          })
        }

        // Hi-hat on every beat
        this.playFile('../../test-assets/audio/hihat_closed.wav', {
          startTime: beatOffset,
          volume: 50,
        })
      }
    }

    // Wait for pattern to complete
    await new Promise((resolve) => setTimeout(resolve, beatDuration * 16 + 1000))
  }

  /**
   * Stop all playing audio
   */
  stop() {
    this.isPlaying = false
    this.processes.forEach((proc) => {
      if (proc && !proc.killed) {
        proc.kill()
      }
    })
    this.processes = []
    console.log('⏹ Audio stopped')
  }
}

/**
 * Quick test function
 */
export async function testSound() {
  const player = new SimpleAudioPlayer()

  console.log('=== Simple Audio Test ===')
  console.log('Testing individual sounds...')

  // Test individual sounds
  await player.playFile('../../test-assets/audio/kick.wav')
  await new Promise((resolve) => setTimeout(resolve, 500))

  await player.playFile('../../test-assets/audio/snare.wav')
  await new Promise((resolve) => setTimeout(resolve, 500))

  await player.playFile('../../test-assets/audio/hihat_closed.wav')
  await new Promise((resolve) => setTimeout(resolve, 500))

  console.log('\nPlaying drum pattern...')
  await player.playDrumPattern(120)

  console.log('\nTest complete!')
}

// If run directly
if (require.main === module) {
  testSound().catch(console.error)
}
