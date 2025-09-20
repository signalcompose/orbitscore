#!/usr/bin/env node

import * as fs from 'fs'
import * as readline from 'readline'

import * as dotenv from 'dotenv'

import { parseSourceToIR } from './parser/parser'
import { Scheduler } from './scheduler'
import { CoreMidiSink } from './midi'

dotenv.config()

// Command line interface for the OrbitScore engine
const command = process.argv[2]

let scheduler: Scheduler | null = null
let midiSink: CoreMidiSink | null = null

async function shutdown() {
  if (scheduler) {
    scheduler.stop()
    scheduler = null
  }

  if (midiSink) {
    try {
      await midiSink.close()
    } catch (error) {
      console.error(`Failed to close MIDI port: ${error instanceof Error ? error.message : error}`)
    }
    midiSink = null
  }
}

function registerSignalHandlers() {
  const exit = (code: number) => {
    shutdown()
      .catch((error) => {
        console.error(`Shutdown error: ${error instanceof Error ? error.message : error}`)
      })
      .finally(() => process.exit(code))
  }

  process.on('SIGINT', () => exit(0))
  process.on('SIGTERM', () => exit(0))
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error)
    exit(1)
  })
}

registerSignalHandlers()

function startEngine() {
  console.log('Starting OrbitScore engine...')

  midiSink = midiSink ?? new CoreMidiSink()
  midiSink.open().catch((error) => {
    console.error(`Failed to open MIDI port: ${error instanceof Error ? error.message : error}`)
  })

  // Create readline interface for transport commands
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  })

  rl.on('line', (line) => {
    handleTransportCommand(line.trim())
  })

  // Start transport state reporting
  setInterval(() => {
    if (scheduler) {
      const state = scheduler.getGlobalPlayheadBarBeat()
      const playing = scheduler.isPlaying()
      const bpm = scheduler.getDisplayBpm()
      const loopEnabled = scheduler.getLoopState().enabled

      console.log(`TRANSPORT:${playing}:${state.bar}:${state.beat}:${bpm}:${loopEnabled}`)
    }
  }, 100)

  console.log('Engine started successfully')
}

async function runFile(filePath: string) {
  try {
    const source = fs.readFileSync(filePath, 'utf8')
    const ir = parseSourceToIR(source)

    if (scheduler) {
      scheduler.stop()
      scheduler = null
    }

    midiSink = midiSink ?? new CoreMidiSink()
    const busNames = Array.from(
      new Set(
        ir.sequences
          .map((seq) => seq.config.bus)
          .filter((name) => typeof name === 'string' && name.trim().length > 0),
      ),
    )
    const primaryBus = busNames[0]
    if (busNames.length > 1 && primaryBus) {
      console.warn(
        `Multiple MIDI buses detected (${busNames.join(', ')}). Using "${primaryBus}" for this run.`,
      )
    }
    await midiSink.open(primaryBus)

    scheduler = new Scheduler(midiSink, ir)
    scheduler.start()

    const busLabel = primaryBus ? `→ ${primaryBus}` : ''
    console.log(`Playing: ${filePath} ${busLabel}`)
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

    case 'jump': {
      const bar = parseInt(parts[1] || '0')
      scheduler.requestJump(bar)
      console.log(`Jump requested to bar ${bar}`)
      break
    }

    case 'loop': {
      const enabled = parts[1] === 'true'
      const start = parseInt(parts[2] || '0')
      const end = parseInt(parts[3] || '4')
      scheduler.setLoop({ enabled, startBar: start, endBar: end })
      console.log(`Loop set: ${enabled} (${start}-${end})`)
      break
    }

    case 'mute': {
      const seqName = parts[1] ?? ''
      const on = parts[2] === 'true'
      if (!seqName) {
        console.error('Usage: mute:<sequenceName>:<true|false>')
        break
      }
      scheduler.setMute(seqName, on)
      console.log(`Mute ${seqName}: ${on}`)
      break
    }

    case 'solo': {
      const list = (parts[1] ?? '').trim()
      if (!list || list.toLowerCase() === 'none') {
        scheduler.setSolo(null)
        console.log('Solo cleared')
        break
      }
      const names = list
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      scheduler.setSolo(names)
      console.log(`Solo: ${names.join(', ')}`)
      break
    }

    case 'status': {
      const state = scheduler.getGlobalPlayheadBarBeat()
      const playing = scheduler.isPlaying()
      const bpm = scheduler.getDisplayBpm()
      const loopEnabled = scheduler.getLoopState().enabled
      console.log(`TRANSPORT:${playing}:${state.bar}:${state.beat}:${bpm}:${loopEnabled}`)
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
  }
}

// Main CLI logic
switch (command) {
  case 'start':
    startEngine()
    break

  case 'run': {
    const filePath = process.argv[3]
    if (!filePath) {
      console.error('Usage: orbitscore run <file.osc>')
      process.exit(1)
    }
    runFile(filePath).catch((error) => {
      console.error(`Failed to run file: ${error instanceof Error ? error.message : error}`)
      process.exit(1)
    })
    break
  }

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
  mute:<seq>:<true|false>   Mute/unmute a sequence by name
  solo:<a,b>|none           Solo sequence list or clear with "none"
  status                    Print one-shot transport line
`)
    break
}
