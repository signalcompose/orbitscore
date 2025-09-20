import type { Output as MidiOutputInstance } from '@julusian/midi'
import { Output as MidiOutputClass } from '@julusian/midi'

export type MidiMessage = {
  timeMs: number
  status: number
  data1: number
  data2: number
}

export interface MidiOut {
  open(portName?: string): Promise<void>
  send(msg: MidiMessage): void
  close(): Promise<void>
}

export class TestMidiSink implements MidiOut {
  public sent: MidiMessage[] = []
  async open(): Promise<void> {}
  send(m: MidiMessage) {
    this.sent.push(m)
  }
  async close(): Promise<void> {}
}

const DEFAULT_MIDI_PORT = 'IAC Driver Bus 1'

type Logger = (message: string) => void

type MidiModule = {
  Output: typeof MidiOutputClass
}

type CoreMidiSinkOptions = {
  midi?: MidiModule
  logger?: Logger
  defaultPortName?: string
}

export class CoreMidiSink implements MidiOut {
  private output: MidiOutputInstance | null = null
  private readonly midi: MidiModule
  private readonly logger: Logger
  private readonly defaultPort: string
  private currentPort: string | null = null

  constructor(options: CoreMidiSinkOptions = {}) {
    this.midi = options.midi ?? { Output: MidiOutputClass }
    this.logger = options.logger ?? (() => {})
    const envPort = process.env.ORBITSCORE_MIDI_PORT?.trim()
    const fallback = options.defaultPortName?.trim() || envPort || DEFAULT_MIDI_PORT
    this.defaultPort = fallback
  }

  async open(portName?: string): Promise<void> {
    const target = (portName ?? this.defaultPort).trim()
    if (!target) {
      throw new Error('CoreMidiSink requires a MIDI port name to open')
    }

    if (this.output && this.output.isPortOpen() && this.currentPort === target) {
      return
    }

    await this.close()

    const output = new this.midi.Output()
    const normalizedTarget = normalizePortName(target)

    const opened =
      this.tryOpenByName(output, target) || this.tryEnumeratedPort(output, normalizedTarget)

    if (!opened) {
      if (typeof output.closePort === 'function') {
        try {
          output.closePort()
        } catch (_) {
          // ignore cleanup errors
        }
      }
      if (typeof output.destroy === 'function') {
        try {
          output.destroy()
        } catch (_) {
          // ignore cleanup errors
        }
      }
      throw new Error(`MIDI port "${target}" not found. Ensure the IAC Bus is enabled.`)
    }

    this.output = output
    this.currentPort = target
    this.logger(`CoreMidiSink connected to "${target}"`)
  }

  send(msg: MidiMessage): void {
    if (!this.output || !this.output.isPortOpen()) {
      throw new Error('CoreMidiSink.send called before opening a MIDI port')
    }

    const status = clampStatus(msg.status)
    const data1 = clamp7Bit(msg.data1)
    const data2 = clamp7Bit(msg.data2)

    this.output.sendMessage([status, data1, data2])
  }

  async close(): Promise<void> {
    if (!this.output) {
      return
    }

    try {
      if (this.output.isPortOpen()) {
        this.output.closePort()
      }
    } finally {
      if (typeof this.output.destroy === 'function') {
        try {
          this.output.destroy()
        } catch (_) {
          // ignore errors during destroy
        }
      }
      this.output = null
      this.currentPort = null
    }
  }

  /** 現在接続しているポート名（未接続なら null） */
  getCurrentPortName(): string | null {
    return this.currentPort
  }

  private tryOpenByName(output: MidiOutputInstance, rawTarget: string): boolean {
    const candidate = output as MidiOutputInstance & { openPortByName?: (name: string) => void }
    if (typeof candidate.openPortByName !== 'function') {
      return false
    }

    try {
      candidate.openPortByName(rawTarget)
      if (output.isPortOpen()) {
        return true
      }
    } catch (error) {
      this.logger(`CoreMidiSink openPortByName failed: ${(error as Error).message}`)
    }

    return false
  }

  private tryEnumeratedPort(output: MidiOutputInstance, normalizedTarget: string): boolean {
    const count = safePortCount(output)

    for (let i = 0; i < count; i += 1) {
      const name = safePortName(output, i)
      if (normalizePortName(name) === normalizedTarget) {
        try {
          output.openPort(i)
          return output.isPortOpen()
        } catch (error) {
          this.logger(`CoreMidiSink openPort failed: ${(error as Error).message}`)
          return false
        }
      }
    }

    return false
  }
}

function clampStatus(value: number): number {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.round(value)
  return Math.max(0, rounded) & 0xff
}

function clamp7Bit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(127, Math.round(value)))
}

function normalizePortName(name: string): string {
  return name.trim().toLowerCase()
}

function safePortCount(output: MidiOutputInstance): number {
  try {
    return output.getPortCount()
  } catch (error) {
    return 0
  }
}

function safePortName(output: MidiOutputInstance, index: number): string {
  try {
    return output.getPortName(index)
  } catch (error) {
    return ''
  }
}
