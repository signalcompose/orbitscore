/**
 * Test sound playback
 */

import { InterpreterV2 } from '../interpreter/interpreter-v2'
import { parseAudioDSL } from '../parser/audio-parser'

/**
 * Play a test sound
 *
 * This function plays a simple drum pattern to verify that the audio
 * engine is working correctly. It uses kick, snare, and hi-hat samples
 * from the test-assets directory.
 *
 * @returns Never resolves (keeps process alive)
 *
 * @example
 * ```typescript
 * await playTestSound()
 * ```
 */
export async function playTestSound(): Promise<void> {
  console.log('Test sound...')

  const testDSL = `
// Test sound - simple drum pattern
var global = init GLOBAL
global.tempo(120).beat(4 by 4)

var kick = init global.seq
kick.beat(4 by 4).length(1)
kick.audio("test-assets/audio/kick.wav")
kick.play(1, 0, 1, 0)

var snare = init global.seq  
snare.beat(4 by 4).length(1)
snare.audio("test-assets/audio/snare.wav")
snare.play(0, 1, 0, 1)

var hihat = init global.seq
hihat.beat(4 by 4).length(1)
hihat.audio("test-assets/audio/hihat_closed.wav")
hihat.play(1, 1, 1, 1)

// Start playback
global.run()
kick.run()
snare.run()
hihat.run()
`

  // Parse and execute
  const ir = parseAudioDSL(testDSL)

  const interpreter = new InterpreterV2()
  await interpreter.execute(ir)

  // Keep process alive indefinitely to continue audio playback
  // This is intentional: the test command is designed to play sound continuously
  // until the user manually terminates with Ctrl+C (SIGINT).
  // The shutdown handlers in shutdown.ts will gracefully stop SuperCollider.
  // Note: This promise never resolves, which is the expected behavior.
  await new Promise(() => {})
}
