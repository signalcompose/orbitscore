#!/usr/bin/env node

/**
 * Audio-based CLI for OrbitScore
 * Executes .osc files and plays audio
 */

import * as fs from 'fs'

import { parseAudioDSL } from './parser/audio-parser'
import { InterpreterV2 } from './interpreter/interpreter-v2'

// Command line interface for the OrbitScore audio engine
const command = process.argv[2]
const file = process.argv[3]

function printUsage() {
  console.log(`
OrbitScore Audio Engine CLI

Usage:
  orbitscore-audio play <file.osc>  - Play an OrbitScore file
  orbitscore-audio test              - Run test sound
  orbitscore-audio help              - Show this help

Examples:
  orbitscore-audio play examples/01_getting_started.osc
  orbitscore-audio test
`)
}

async function playFile(filepath: string) {
  try {
    // Check if file exists
    if (!fs.existsSync(filepath)) {
      console.error(`File not found: ${filepath}`)
      process.exit(1)
    }

    // Read the DSL file
    const source = fs.readFileSync(filepath, 'utf8')
    console.log('=== Loading OrbitScore file ===')
    console.log(`File: ${filepath}`)
    console.log()

    // Parse the DSL
    console.log('=== Parsing DSL ===')
    const ir = parseAudioDSL(source)
    console.log(`Parsed ${ir.statements.length} statements`)
    console.log()

    // Execute with interpreter
    console.log('=== Executing ===')
    const interpreter = new InterpreterV2()
    await interpreter.execute(ir)

    // Get final state
    const state = interpreter.getState()
    console.log()
    console.log('=== Execution Complete ===')
    console.log(`Globals created: ${Object.keys(state.globals).length}`)
    console.log(`Sequences created: ${Object.keys(state.sequences).length}`)

    // List sequences and their states
    for (const [name, seq] of Object.entries(state.sequences)) {
      console.log(`  - ${name}: ${(seq as any).isPlaying ? '▶️ playing' : '⏸ stopped'}`)
    }

    // Keep the process alive if audio is playing
    if (
      Object.values(state.sequences).some((s: any) => s.isPlaying) ||
      Object.values(state.globals).some((g: any) => g.isRunning)
    ) {
      console.log()
      console.log('🎵 Audio is playing. Press Ctrl+C to stop.')

      // Keep process alive
      setInterval(() => {}, 1000)
    }
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  }
}

async function playTestSound() {
  console.log('=== Test Sound ===')
  console.log('Playing a simple drum pattern...')

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

  console.log()
  console.log('Test pattern loaded:')
  console.log('  - Kick:  [1, 0, 1, 0]')
  console.log('  - Snare: [0, 1, 0, 1]')
  console.log('  - HiHat: [1, 1, 1, 1]')
  console.log()
  console.log('🎵 Playing test pattern. Press Ctrl+C to stop.')

  // Keep process alive
  setInterval(() => {}, 1000)
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n👋 Stopping audio...')
  process.exit(0)
})

// Main
async function main() {
  switch (command) {
    case 'play':
      if (!file) {
        console.error('Please specify a file to play')
        printUsage()
        process.exit(1)
      }
      await playFile(file)
      break

    case 'run':
      if (!file) {
        console.error('Please specify a file to run')
        printUsage()
        process.exit(1)
      }
      await playFile(file)
      break

    case 'eval':
      if (!file) {
        console.error('Please specify a file to evaluate')
        printUsage()
        process.exit(1)
      }
      await playFile(file)
      break

    case 'test':
      await playTestSound()
      break

    case 'help':
    case undefined:
      printUsage()
      break

    default:
      console.error(`Unknown command: ${command}`)
      printUsage()
      process.exit(1)
  }
}

// Run the CLI
main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
