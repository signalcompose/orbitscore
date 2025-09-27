/**
 * Interpreter for OrbitScore Audio DSL
 * Executes parsed IR using the audio engine
 */

import { AudioIR, GlobalInit, SequenceInit, Statement, PlayElement } from '../parser/audio-parser'
import { AudioEngine, AudioFile, AudioSlice } from '../audio/audio-engine'
import { Transport, TransportSequence } from '../transport/transport'
import { TimingCalculator, TimedEvent } from '../timing/timing-calculator'

/**
 * Global transport state
 */
interface GlobalState {
  tempo: number
  tick: number
  beat: { numerator: number; denominator: number }
  key: string
  isRunning: boolean
  isLooping: boolean
}

/**
 * Sequence state
 */
interface SequenceState {
  name: string
  tempo?: number
  beat?: { numerator: number; denominator: number }
  length?: number // Loop length in bars
  audioFile?: AudioFile
  slices: AudioSlice[]
  playPattern?: PlayElement[] // Store the play pattern
  timedEvents?: TimedEvent[] // Calculated timing
  isMuted: boolean
  isPlaying: boolean
}

/**
 * Main interpreter class
 */
export class Interpreter {
  private audioEngine: AudioEngine
  private transport: Transport
  private globalState: GlobalState
  private sequences: Map<string, SequenceState> = new Map()
  private audioFiles: Map<string, AudioFile> = new Map()

  constructor() {
    this.audioEngine = new AudioEngine()
    this.transport = new Transport(this.audioEngine)

    // Initialize global state with defaults
    this.globalState = {
      tempo: 120,
      tick: 480,
      beat: { numerator: 4, denominator: 4 },
      key: 'C',
      isRunning: false,
      isLooping: false,
    }
  }

  /**
   * Execute parsed IR
   */
  async execute(ir: AudioIR): Promise<void> {
    // Process initializations
    if (ir.globalInit) {
      this.processGlobalInit(ir.globalInit)
    }

    for (const seqInit of ir.sequenceInits) {
      this.processSequenceInit(seqInit)
    }

    // Process statements
    for (const statement of ir.statements) {
      await this.processStatement(statement)
    }
  }

  /**
   * Process global initialization
   */
  private processGlobalInit(init: GlobalInit): void {
    console.log(`Initialized global: ${init.variableName}`)
    // Global state is already initialized with defaults
  }

  /**
   * Process sequence initialization
   */
  private processSequenceInit(init: SequenceInit): void {
    const sequence: SequenceState = {
      name: init.variableName,
      slices: [],
      isMuted: false,
      isPlaying: false,
    }

    this.sequences.set(init.variableName, sequence)

    // Also register with transport system
    const transportSeq: TransportSequence = {
      id: init.variableName,
      slices: [],
      loop: false,
      muted: false,
      state: 'stopped',
    }
    this.transport.addSequence(transportSeq)

    console.log(`Initialized sequence: ${init.variableName}`)
  }

  /**
   * Process a statement
   */
  private async processStatement(statement: Statement): Promise<void> {
    switch (statement.type) {
      case 'global':
        await this.processGlobalStatement(statement as any)
        break
      case 'sequence':
        await this.processSequenceStatement(statement as any)
        break
      case 'transport':
        await this.processTransportStatement(statement as any)
        break
    }
  }

  /**
   * Process global statement
   */
  private async processGlobalStatement(statement: any): Promise<void> {
    const { method, args } = statement

    switch (method) {
      case 'tempo':
        this.globalState.tempo = args[0]
        this.transport.setTempo(args[0])
        console.log(`Set global tempo: ${args[0]}`)
        break

      case 'tick':
        this.globalState.tick = args[0]
        console.log(`Set global tick: ${args[0]}`)
        break

      case 'beat': {
        const beat = args[0]
        if (typeof beat === 'object' && 'numerator' in beat) {
          this.globalState.beat = beat
          this.transport.setMeter(beat)
          console.log(`Set global beat: ${beat.numerator}/${beat.denominator}`)
        }
        break
      }

      case 'key':
        this.globalState.key = args[0]
        console.log(`Set global key: ${args[0]}`)
        break

      case 'run':
        await this.startGlobal(args)
        break

      case 'loop':
        await this.loopGlobal(args)
        break

      case 'stop':
        this.stopGlobal()
        break
    }
  }

  /**
   * Process sequence statement
   */
  private async processSequenceStatement(statement: any): Promise<void> {
    const { target, method, args, chain } = statement
    const sequence = this.sequences.get(target)

    if (!sequence) {
      console.warn(`Sequence not found: ${target}`)
      return
    }

    switch (method) {
      case 'tempo':
        sequence.tempo = args[0]
        console.log(`Set ${target} tempo: ${args[0]}`)
        break

      case 'beat': {
        const beat = args[0]
        if (typeof beat === 'object' && 'numerator' in beat) {
          sequence.beat = beat
          console.log(`Set ${target} beat: ${beat.numerator}/${beat.denominator}`)
        }
        break
      }

      case 'audio': {
        const audioPath = args[0]
        const audioFile = await this.audioEngine.loadAudioFile(audioPath)
        sequence.audioFile = audioFile
        this.audioFiles.set(audioPath, audioFile)
        console.log(`Loaded audio for ${target}: ${audioPath}`)

        // Process chain (e.g., .chop())
        if (chain) {
          for (const chainMethod of chain) {
            if (chainMethod.method === 'chop') {
              const numSlices = chainMethod.args[0]
              sequence.slices = audioFile.chop(numSlices)
              console.log(`Chopped ${target} audio into ${numSlices} slices`)

              // Update transport sequence
              const transportSeq: TransportSequence = {
                id: target,
                slices: sequence.slices,
                tempo: sequence.tempo,
                meter: sequence.beat,
                loop: false,
                muted: sequence.isMuted,
                state: sequence.isPlaying ? 'playing' : 'stopped',
              }
              this.transport.addSequence(transportSeq)
            }
          }
        }
        break
      }

      case 'play':
        await this.playSequence(sequence, args, chain)
        break

      case 'mute':
        sequence.isMuted = true
        console.log(`Muted ${target}`)
        break

      case 'unmute':
        sequence.isMuted = false
        console.log(`Unmuted ${target}`)
        break
    }
  }

  /**
   * Process transport statement
   */
  private async processTransportStatement(statement: any): Promise<void> {
    const { target, command, force, sequences } = statement

    if (target === 'global') {
      switch (command) {
        case 'run':
          await this.startGlobal(sequences || [], force)
          break
        case 'loop':
          await this.loopGlobal(sequences || [], force)
          break
        case 'stop':
          this.stopGlobal()
          break
      }
    } else {
      // Sequence-specific transport
      const sequence = this.sequences.get(target)
      if (sequence) {
        switch (command) {
          case 'run':
            await this.startSequence(sequence, force)
            break
          case 'loop':
            await this.loopSequence(sequence, force)
            break
          case 'stop':
            this.stopSequence(sequence)
            break
          case 'mute':
            sequence.isMuted = true
            break
          case 'unmute':
            sequence.isMuted = false
            break
        }
      }
    }
  }

  /**
   * Play a sequence with given arguments
   */
  private async playSequence(sequence: SequenceState, args: any[], chain?: any[]): Promise<void> {
    if (!sequence.audioFile || sequence.slices.length === 0) {
      console.warn(`No audio loaded for sequence: ${sequence.name}`)
      return
    }

    // Store the play pattern for later use
    sequence.playPattern = args

    // Calculate bar duration
    const tempo = sequence.tempo || this.globalState.tempo
    const meter = sequence.beat || this.globalState.beat
    const beatsPerBar = meter.numerator
    const beatDuration = 60000 / tempo // ms per beat
    const barDuration = beatDuration * beatsPerBar

    // Calculate hierarchical timing
    const timedEvents = TimingCalculator.calculateTiming(args, barDuration)
    sequence.timedEvents = timedEvents

    // Debug output
    console.log(`Playing ${sequence.name} with hierarchical timing:`)
    console.log(TimingCalculator.formatTiming(timedEvents, tempo))

    // Check for modifiers in chain
    let fixpitch: number | undefined
    let timeStretch: number = 1.0
    if (chain) {
      for (const chainMethod of chain) {
        if (chainMethod.method === 'fixpitch') {
          fixpitch = chainMethod.args[0]
        } else if (chainMethod.method === 'time') {
          timeStretch = chainMethod.args[0]
        }
      }
    }

    // Schedule events with the transport system
    if (this.transport) {
      // Create events for transport scheduling
      for (const event of timedEvents) {
        if (event.sliceNumber > 0 && event.sliceNumber <= sequence.slices.length) {
          const slice = sequence.slices[event.sliceNumber - 1] // slices are 0-indexed

          // Register the timed playback with transport
          // This will be handled by the transport system's scheduling
          // Note: Transport.scheduleEvent doesn't exist yet, need to implement
          // For now, we'll use the audio engine directly with startTime
          const audioContextTime = this.audioEngine.getAudioContext().currentTime
          const startTime = audioContextTime + event.startTime / 1000 // Convert ms to seconds

          this.audioEngine.playSlice(slice, {
            tempo: (tempo / 120) * timeStretch,
            pitch: fixpitch,
            startTime: startTime,
          })
        }
        // If sliceNumber is 0, it's silence - no playback needed
      }
    } else {
      // Fallback: immediate playback without timing (for testing)
      console.warn('No transport system - playing immediately without timing')
      const slicesToPlay: AudioSlice[] = []
      for (const event of timedEvents) {
        if (event.sliceNumber > 0 && event.sliceNumber <= sequence.slices.length) {
          slicesToPlay.push(sequence.slices[event.sliceNumber - 1])
        }
      }

      if (slicesToPlay.length > 0) {
        this.audioEngine.playSequence(slicesToPlay, {
          tempo: tempo / 120,
          loop: false,
        })
      }
    }

    sequence.isPlaying = true
  }

  /**
   * Parse play arguments to extract slice numbers
   */
  private parsePlayArguments(args: any[]): number[] {
    const sliceNumbers: number[] = []

    for (const arg of args) {
      if (typeof arg === 'number') {
        sliceNumbers.push(arg)
      } else if (arg.type === 'nested') {
        // Handle nested structure
        sliceNumbers.push(...this.parsePlayElements(arg.elements))
      } else if (arg.type === 'modified') {
        // Handle modified element (e.g., 1.chop(2))
        if (typeof arg.value === 'number') {
          sliceNumbers.push(arg.value)
        }
      }
    }

    return sliceNumbers
  }

  /**
   * Parse play elements recursively
   */
  private parsePlayElements(elements: PlayElement[]): number[] {
    const sliceNumbers: number[] = []

    for (const element of elements) {
      if (typeof element === 'number') {
        sliceNumbers.push(element)
      } else if ((element as any).type === 'nested') {
        sliceNumbers.push(...this.parsePlayElements((element as any).elements))
      } else if ((element as any).type === 'modified') {
        if (typeof (element as any).value === 'number') {
          sliceNumbers.push((element as any).value)
        }
      }
    }

    return sliceNumbers
  }

  /**
   * Start global transport
   */
  private async startGlobal(sequences: string[] = [], force: boolean = false): Promise<void> {
    console.log(`Starting global transport${force ? ' (forced)' : ''}`)
    this.globalState.isRunning = true

    // Use transport system
    this.transport.start(force)

    if (sequences.length > 0) {
      // Start specific sequences
      for (const seqName of sequences) {
        this.transport.startSequence(seqName, force)
      }
    }
  }

  /**
   * Loop global transport
   */
  private async loopGlobal(sequences: string[] = [], force: boolean = false): Promise<void> {
    console.log(`Looping global transport${force ? ' (forced)' : ''}`)
    this.globalState.isRunning = true
    this.globalState.isLooping = true

    // Use transport system
    this.transport.loop(sequences.length > 0 ? sequences : undefined, force)
  }

  /**
   * Stop global transport
   */
  private stopGlobal(): void {
    console.log('Stopping global transport')
    this.globalState.isRunning = false
    this.globalState.isLooping = false

    // Use transport system
    this.transport.stop(true)

    // Mark all sequences as stopped
    for (const seq of this.sequences.values()) {
      seq.isPlaying = false
    }
  }

  /**
   * Start a sequence
   */
  private async startSequence(sequence: SequenceState, force: boolean = false): Promise<void> {
    if (!sequence.isMuted) {
      console.log(`Starting sequence: ${sequence.name}${force ? ' (forced)' : ''}`)
      sequence.isPlaying = true
      // Implementation would handle sequence start
    }
  }

  /**
   * Loop a sequence
   */
  private async loopSequence(sequence: SequenceState, force: boolean = false): Promise<void> {
    if (!sequence.isMuted) {
      console.log(`Looping sequence: ${sequence.name}${force ? ' (forced)' : ''}`)
      sequence.isPlaying = true
      // Implementation would handle sequence looping
    }
  }

  /**
   * Stop a sequence
   */
  private stopSequence(sequence: SequenceState): void {
    console.log(`Stopping sequence: ${sequence.name}`)
    sequence.isPlaying = false
    // Implementation would handle sequence stop
  }

  /**
   * Get current state
   */
  getState(): { global: GlobalState; sequences: SequenceState[] } {
    return {
      global: this.globalState,
      sequences: Array.from(this.sequences.values()),
    }
  }

  /**
   * Cleanup resources
   */
  async dispose(): Promise<void> {
    this.stopGlobal()
    this.transport.dispose()
    await this.audioEngine.dispose()
  }
}
