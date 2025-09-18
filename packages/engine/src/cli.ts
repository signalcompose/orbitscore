#!/usr/bin/env node

import * as fs from 'fs'
import * as readline from 'readline'
import { parseSourceToIR } from './parser/parser'
import { Scheduler } from './scheduler'
import { CoreMidiSink } from './midi'

// Command line interface for the OrbitScore engine
const command = process.argv[2]

let scheduler: Scheduler | null = null

function startEngine() {
  console.log('Starting OrbitScore engine...')
  
  // For now, use TestMidiSink until CoreMidi is implemented
  const sink = new CoreMidiSink()
  
  // Create readline interface for transport commands
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  })

  rl.on('line', (line) => {
    handleTransportCommand(line.trim())
  })

  // Start transport state reporting
  setInterval(() => {
    if (scheduler) {
      const state = scheduler.getGlobalPlayheadBarBeat()
      const playing = scheduler.isPlaying()
      const bpm = 120 // TODO: get from current tempo
      const loopEnabled = false // TODO: get loop state
      
      console.log(`TRANSPORT:${playing}:${state.bar}:${state.beat}:${bpm}:${loopEnabled}`)
    }
  }, 100)

  console.log('Engine started successfully')
}

function runFile(filePath: string) {
  try {
    const source = fs.readFileSync(filePath, 'utf8')
    const ir = parseSourceToIR(source)
    
    // Create scheduler if not exists
    if (!scheduler) {
      const sink = new CoreMidiSink()
      scheduler = new Scheduler(sink as any, ir)
    }
    
    // Start playback
    scheduler.start()
    console.log(`Playing: ${filePath}`)
    
  } catch (error) {
    console.error(`Error running file: ${error}`)
    process.exit(1)
  }
}

function handleTransportCommand(command: string) {
  if (!scheduler) {
    console.error('No scheduler active')
    return
  }

  const parts = command.split(':')
  const cmd = parts[0]

  switch (cmd) {
    case 'play':
      scheduler.start()
      console.log('Playback started')
      break
      
    case 'pause':
      scheduler.stop()
      console.log('Playback paused')
      break
      
    case 'stop':
      scheduler.stop()
      scheduler.setCurrentTimeSec(0)
      console.log('Playback stopped')
      break
      
    case 'jump':
      const bar = parseInt(parts[1] || '0')
      scheduler.requestJump(bar)
      console.log(`Jump requested to bar ${bar}`)
      break
      
    case 'loop':
      const enabled = parts[1] === 'true'
      const start = parseInt(parts[2] || '0')
      const end = parseInt(parts[3] || '4')
      scheduler.setLoop({ enabled, startBar: start, endBar: end })
      console.log(`Loop set: ${enabled} (${start}-${end})`)
      break
      
    default:
      console.error(`Unknown command: ${command}`)
  }
}

// Main CLI logic
switch (command) {
  case 'start':
    startEngine()
    break
    
  case 'run':
    const filePath = process.argv[3]
    if (!filePath) {
      console.error('Usage: orbitscore run <file.osc>')
      process.exit(1)
    }
    runFile(filePath)
    break
    
  case 'help':
  default:
    console.log(`
OrbitScore Engine CLI

Usage:
  orbitscore start           Start the engine daemon
  orbitscore run <file>      Run an .osc file
  orbitscore help           Show this help

Transport commands (when engine is running):
  play                      Start playback
  pause                     Pause playback  
  stop                      Stop and reset to beginning
  jump:<bar>                Jump to bar number
  loop:<enabled>:<start>:<end>  Set loop range
`)
    break
}