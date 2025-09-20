#!/usr/bin/env node

import * as fs from 'fs'
import * as readline from 'readline'

import * as dotenv from 'dotenv'
import { Output as MidiOutput } from '@julusian/midi'

import { CoreMidiSink } from './midi'
import { parseSourceToIR } from './parser/parser'
import { Scheduler } from './scheduler'

dotenv.config()

// Command line interface for the OrbitScore engine
const command = process.argv[2]

let scheduler: Scheduler | null = null
let midiSink: CoreMidiSink | null = null
let lastEmit: { playing: boolean; bar: number; beat: number; bpm: number; loop: boolean } | null =
  null

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

  // Start transport state reporting (throttled to meaningful changes)
  setInterval(() => {
    if (scheduler) {
      const state = scheduler.getGlobalPlayheadBarBeat()
      const playing = scheduler.isPlaying()
      const bpm = scheduler.getDisplayBpm()
      const loopEnabled = scheduler.getLoopState().enabled

      // beatは整数へ丸め（拡張の正規表現互換のため）
      const beatInt = Math.floor(state.beat)
      const current = { playing, bar: state.bar, beat: beatInt, bpm, loop: loopEnabled }
      const changed =
        !lastEmit ||
        lastEmit.playing !== current.playing ||
        lastEmit.bar !== current.bar ||
        lastEmit.beat !== current.beat ||
        lastEmit.bpm !== current.bpm ||
        lastEmit.loop !== current.loop

      if (changed) {
        console.log(`TRANSPORT:${playing}:${state.bar}:${beatInt}:${bpm}:${loopEnabled}`)
        lastEmit = current
      }
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

  function listPorts(): string[] {
    try {
      const out = new MidiOutput()
      const n = out.getPortCount()
      const names: string[] = []
      for (let i = 0; i < n; i++) names.push(out.getPortName(i))
      try {
        out.closePort()
        // eslint-disable-next-line no-empty
      } catch {}
      if (typeof (out as any).destroy === 'function') (out as any).destroy()
      return names
    } catch (e) {
      console.error(`Failed to enumerate ports: ${e instanceof Error ? e.message : e}`)
      return []
    }
  }

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
      const loopState = scheduler.getLoopState()
      const beatsPerBar = scheduler.getDisplayBeatsPerBar()
      const beatInt = Math.floor(state.beat)
      console.log(`TRANSPORT:${playing}:${state.bar}:${beatInt}:${bpm}:${loopState.enabled}`)
      // 追加ステータス（JSONで出力）
      const extra = {
        mute: scheduler.getMuteList(),
        solo: scheduler.getSoloList(),
        port: midiSink?.getCurrentPortName() ?? null,
        loop: loopState,
        bpm,
        beatsPerBar,
      }
      console.log(`STATUS:${JSON.stringify(extra)}`)
      break
    }

    case 'port': {
      const arg = (parts[1] || '').trim()
      if (!midiSink) {
        console.error('No MIDI sink available')
        break
      }
      if (!arg) {
        console.error('Usage: port:<MIDI Port Name | index>  (use "ports" to list)')
        break
      }
      // Accept numeric index or name
      const maybeIndex = Number.isFinite(Number(arg)) ? Number(arg) : NaN
      if (!Number.isNaN(maybeIndex)) {
        const names = listPorts()
        const target = names[maybeIndex]
        if (!target) {
          console.error(`Invalid port index ${maybeIndex}. Use "ports" to list.`)
          break
        }
        midiSink
          .open(target)
          .then(() => console.log(`MIDI port switched to "${target}"`))
          .catch((e) =>
            console.error(`Failed to switch port: ${e instanceof Error ? e.message : e}`),
          )
      } else {
        midiSink
          .open(arg)
          .then(() => console.log(`MIDI port switched to "${arg}"`))
          .catch((e) =>
            console.error(`Failed to switch port: ${e instanceof Error ? e.message : e}`),
          )
      }
      break
    }

    case 'ports': {
      const names = listPorts()
      console.log(`PORTS:${JSON.stringify(names)}`)
      console.log(
        names.length
          ? names.map((n, i) => `${i}: ${n}`).join('\n')
          : 'No ports (is IAC Driver enabled?)',
      )
      break
    }

    case 'eval': {
      const file = (parts[1] || '').trim()
      if (!file) {
        console.error('Usage: eval:<file.osc>')
        break
      }
      ;(async () => {
        try {
          const source = fs.readFileSync(file, 'utf8')
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
          if (primaryBus) {
            await midiSink.open(primaryBus)
          }
          scheduler = new Scheduler(midiSink, ir)
          scheduler.start()
          console.log(`Reloaded: ${file}${primaryBus ? ` → ${primaryBus}` : ''}`)
        } catch (error) {
          console.error(`Eval failed: ${error}`)
        }
      })()
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
  port:<name>               Switch MIDI port
`)
    break
}
