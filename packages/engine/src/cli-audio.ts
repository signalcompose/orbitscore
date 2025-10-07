#!/usr/bin/env node

/**
 * Audio-based CLI for OrbitScore
 * Executes .osc files and plays audio
 */

import * as fs from 'fs'
import * as readline from 'readline'

import { parseAudioDSL } from './parser/audio-parser'
import { InterpreterV2 } from './interpreter/interpreter-v2'

// Command line interface for the OrbitScore audio engine
const args = process.argv.slice(2)
const command = args[0]

// Parse command line options
let audioDevice: string | undefined
let file: string | undefined
let durationArg: string | undefined
let debugMode: boolean = false

for (let i = 1; i < args.length; i++) {
  if (args[i] === '--audio-device' && args[i + 1]) {
    audioDevice = args[i + 1]
    i++ // Skip next arg
  } else if (args[i] === '--debug') {
    debugMode = true
  } else if (!file) {
    file = args[i]
  } else if (!durationArg) {
    durationArg = args[i]
  }
}

// Set global debug flag
;(globalThis as any).ORBITSCORE_DEBUG = debugMode

function printUsage() {
  console.log(`
OrbitScore Audio Engine CLI

Usage:
  orbitscore-audio play <file.osc> [duration]  - Play an OrbitScore file (optional duration in seconds)
  orbitscore-audio repl                         - Start REPL mode for live coding
  orbitscore-audio eval <file.osc>              - Evaluate a file in persistent mode
  orbitscore-audio test                         - Run test sound
  orbitscore-audio help                         - Show this help

Examples:
  orbitscore-audio play examples/01_getting_started.osc     - Play until completion
  orbitscore-audio play examples/01_getting_started.osc 5   - Play for 5 seconds then stop
  orbitscore-audio repl                                      - Start live coding REPL
  orbitscore-audio test
`)
}

// Shared interpreter instance for REPL mode
let globalInterpreter: InterpreterV2 | null = null

async function playFile(filepath: string, durationSeconds?: number) {
  try {
    // Check if file exists
    if (!fs.existsSync(filepath)) {
      console.error(`File not found: ${filepath}`)
      process.exit(1)
    }

    // Read the DSL file
    const source = fs.readFileSync(filepath, 'utf8')

    // Parse the DSL
    const ir = parseAudioDSL(source)

    // Create interpreter only if not already exists (for REPL persistence)
    if (!globalInterpreter) {
      console.log('🆕 Creating new interpreter')
      globalInterpreter = new InterpreterV2()
    } else {
      console.log('♻️ Reusing existing interpreter')
    }
    
    await globalInterpreter.execute(ir)

    // Get final state
    const state = globalInterpreter.getState()

    // Check if global.run() was called
    const hasRunningGlobal = Object.values(state.globals).some((g: any) => g.isRunning)
    
    if (durationSeconds && globalInterpreter) {
      // Timed execution mode with auto-exit when all sequences finish
      const maxWaitTime = durationSeconds * 1000
      const startTime = Date.now()
      const interpreter = globalInterpreter // Capture for closure
      
      const checkInterval = setInterval(() => {
        const currentState = interpreter.getState()
        const isAnyPlaying = Object.values(currentState.sequences).some((s: any) => s.isPlaying)
        const elapsed = Date.now() - startTime
        
        if (!isAnyPlaying || elapsed >= maxWaitTime) {
          clearInterval(checkInterval)
          console.log('✅ Playback finished')
          process.exit(0)
        }
      }, 100) // Check every 100ms
    } else if (hasRunningGlobal) {
      // Interactive REPL mode (only if no duration specified)
      console.log('🎵 Live coding mode')
      await startREPL(globalInterpreter)
    } else {
      // One-shot mode
      const isPlaying = Object.values(state.sequences).some((s: any) => s.isPlaying)
      if (isPlaying) {
        setInterval(() => {}, 1000)
      }
    }
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  }
}

async function startREPL(interpreter: InterpreterV2) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  })

  rl.on('line', async (line) => {
    const code = line.trim()
    if (!code) return

    try {
      // Parse and execute the single line command
      const ir = parseAudioDSL(code)
      await interpreter.execute(ir)
      console.log('✓') // Success indicator
    } catch (error: any) {
      console.error(`[ERROR] ${error.message}`)
    }
  })

  // Keep process alive
  await new Promise(() => {}) // Never resolves
}

async function playTestSound() {
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

  setInterval(() => {}, 1000)
}

// Handle Ctrl+C and SIGTERM gracefully
async function shutdown() {
  if (globalInterpreter) {
    try {
      // Quit SuperCollider server
      const audioEngine = (globalInterpreter as any).audioEngine
      if (audioEngine && typeof audioEngine.quit === 'function') {
        await audioEngine.quit()
      }
    } catch (e) {
      // Ignore errors during shutdown
    }
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Main
async function main() {
  switch (command) {
    case 'play': {
      if (!file) {
        console.error('Please specify a file to play')
        printUsage()
        process.exit(1)
      }
      const playDuration = durationArg ? parseFloat(durationArg) : undefined
      await playFile(file, playDuration)
      break
    }

    case 'run': {
      if (!file) {
        console.error('Please specify a file to run')
        printUsage()
        process.exit(1)
      }
      const runDuration = durationArg ? parseFloat(durationArg) : undefined
      await playFile(file, runDuration)
      break
    }

    case 'repl': {
      // Start REPL mode without requiring a file
      console.log('🎵 OrbitScore Audio Engine')
      console.log('✅ Initialized')
      
      // Create a global interpreter
      const { InterpreterV2 } = await import('./interpreter/interpreter-v2')
      globalInterpreter = new InterpreterV2()
      
      // Boot SuperCollider once at startup with optional audio device
      await globalInterpreter.boot(audioDevice)
      
      console.log('🎵 Live coding mode')
      await startREPL(globalInterpreter)
      break
    }

    case 'eval': {
      if (!file) {
        console.error('Please specify a file to evaluate')
        printUsage()
        process.exit(1)
      }
      const evalDuration = durationArg ? parseFloat(durationArg) : undefined
      await playFile(file, evalDuration)
      break
    }

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
