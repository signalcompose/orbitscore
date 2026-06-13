/**
 * Headless MIDI runner — evaluate a MIDI `.orbs` through the REAL engine path
 * (parser → degree resolution → MidiScheduler → MidiOutput → IAC) WITHOUT
 * booting SuperCollider.
 *
 * MIDI sequences schedule against the shared TransportClock (no SC), so a no-op
 * audio engine is enough: the default MidiManager opens the real IAC port via
 * RtMidiOutput. This is the truthful Phase 1 (#228) run — what you hear is what
 * the engine actually produced from the DSL, not hand-crafted MIDI.
 *
 * Optionally reports the evaluated source to the MIDI monitor's `/pattern`
 * endpoint so the on-screen "Now playing (DSL)" shows the real DSL.
 *
 * Usage:
 *   ts-node packages/engine/src/cli/midi-run.ts <file.orbs> [monitorUrl]
 *   (monitorUrl default: http://localhost:8137 — the tools/midi-monitor server)
 */

import * as fs from 'fs'
import * as path from 'path'

import { parseAudioDSL } from '../parser/audio-parser'
import { processGlobalInit, processSequenceInit } from '../interpreter/process-initialization'
import { processStatement } from '../interpreter/process-statement'
import { InterpreterState } from '../interpreter/types'

/**
 * No-op audio engine. MIDI runs on the TransportClock (no SuperCollider), so
 * every audio/scheduler method here is a harmless stub. Only `start`/`stopAll`
 * are reached (via global transport control); the rest exist to satisfy the
 * AudioEngine + Scheduler surface.
 */
const noopEngine = {
  isRunning: false,
  async boot(): Promise<void> {},
  async quit(): Promise<void> {},
  start(): void {},
  stop(): void {},
  stopAll(): void {},
  clearSequenceEvents(): void {},
  reinitializeSequenceTracking(): void {},
  scheduleEvent(): void {},
  scheduleSliceEvent(): void {},
  getAudioDuration(): number {
    return 0
  },
}

async function reportPattern(monitorUrl: string, source: string, label: string): Promise<void> {
  try {
    await fetch(`${monitorUrl}/pattern`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, label }),
    })
  } catch {
    // Monitor not running — that's fine, the .orbs still plays to IAC.
  }
}

async function main(): Promise<void> {
  const file = process.argv[2]
  const monitorUrl = process.argv[3] || 'http://localhost:8137'
  if (!file) {
    console.error('usage: midi-run <file.orbs> [monitorUrl]')
    process.exit(1)
    return
  }

  const source = fs.readFileSync(file, 'utf8')
  const ir = parseAudioDSL(source)

  const state: InterpreterState = {
    globals: new Map(),
    sequences: new Map(),
    currentGlobal: undefined,
    audioEngine: noopEngine as unknown as InterpreterState['audioEngine'],
    isBooted: true,
    runGroup: new Set(),
    loopGroup: new Set(),
    muteGroup: new Set(),
  }

  // Report the DSL to the monitor — honest: this is the exact source the engine
  // evaluates, so the on-screen pattern can never disagree with the notes.
  await reportPattern(monitorUrl, source, path.basename(file))

  if (ir.globalInit) {
    await processGlobalInit(ir.globalInit, state)
  }
  for (const seqInit of ir.sequenceInits) {
    await processSequenceInit(seqInit, state)
  }
  for (const stmt of ir.statements) {
    await processStatement(stmt, state)
  }

  console.log(`▶ running ${path.basename(file)} → IAC (Ctrl+C to stop)`)

  const shutdown = (): void => {
    try {
      state.currentGlobal?.stop() // panic: all notes off
    } catch {
      // ignore
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // LOOP keeps the event loop alive via the MidiScheduler interval. Add a
  // backstop heartbeat so a RUN-only file also stays up until Ctrl+C.
  setInterval(() => {}, 1 << 30)
}

main().catch((e) => {
  console.error('midi-run error:', e?.message ?? e)
  process.exit(1)
})
