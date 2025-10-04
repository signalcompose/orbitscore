/**
 * Interpreter V2 for OrbitScore Audio DSL
 * Object-oriented implementation with proper class instantiation
 */

import { AudioIR, GlobalInit, SequenceInit, Statement } from '../parser/audio-parser'
import { AudioEngine } from '../audio/audio-engine'
import { Global } from '../core/global'
import { Sequence } from '../core/sequence'

/**
 * Interpreter V2 - Object-oriented approach
 */
export class InterpreterV2 {
  private audioEngine: AudioEngine
  private globals: Map<string, Global> = new Map()
  private sequences: Map<string, Sequence> = new Map()
  private currentGlobal?: Global

  constructor() {
    this.audioEngine = new AudioEngine()
  }

  /**
   * Execute parsed IR
   */
  async execute(ir: AudioIR): Promise<void> {
    // Process global initialization
    if (ir.globalInit) {
      await this.processGlobalInit(ir.globalInit)
    }

    // Process sequence initializations
    for (const seqInit of ir.sequenceInits) {
      await this.processSequenceInit(seqInit)
    }

    // Process statements
    for (const statement of ir.statements) {
      await this.processStatement(statement)
    }
  }

  /**
   * Process global initialization: var global = init GLOBAL
   */
  private async processGlobalInit(init: GlobalInit): Promise<void> {
    const globalInstance = new Global(this.audioEngine)
    this.globals.set(init.variableName, globalInstance)
    this.currentGlobal = globalInstance
    // Global: ${init.variableName}
  }

  /**
   * Process sequence initialization: var seq = init global.seq
   */
  private async processSequenceInit(init: SequenceInit): Promise<void> {
    let global: Global | undefined

    // If globalVariable is specified (new syntax: init global.seq)
    if (init.globalVariable) {
      global = this.globals.get(init.globalVariable)
      if (!global) {
        console.error(`Global instance not found: ${init.globalVariable}`)
        return
      }
    } else {
      // Legacy syntax: init GLOBAL.seq
      global = this.currentGlobal
      if (!global) {
        console.error('No global instance available for sequence initialization')
        return
      }
    }

    // Create sequence through the Global's factory method
    const sequence = global.seq
    sequence.setName(init.variableName)
    this.sequences.set(init.variableName, sequence)
    // Sequence: ${init.variableName}
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
      default:
        console.warn(`Unknown statement type: ${(statement as any).type}`)
    }
  }

  /**
   * Process global method calls
   */
  private async processGlobalStatement(statement: any): Promise<void> {
    const global = this.globals.get(statement.target)
    if (!global) {
      console.error(`Global instance not found: ${statement.target}`)
      return
    }

    // Start with the global object
    let result: any = global

    // Process the main method
    result = await this.callMethod(result, statement.method, statement.args)

    // Process any chained methods
    if (statement.chain) {
      for (const chainedCall of statement.chain) {
        result = await this.callMethod(result, chainedCall.method, chainedCall.args)
      }
    }
  }

  /**
   * Process sequence method calls
   */
  private async processSequenceStatement(statement: any): Promise<void> {
    const sequence = this.sequences.get(statement.target)
    if (!sequence) {
      console.error(`Sequence instance not found: ${statement.target}`)
      return
    }

    // Start with the sequence object
    let result: any = sequence

    // Process the main method
    result = await this.callMethod(result, statement.method, statement.args)

    // Process any chained methods
    if (statement.chain) {
      for (const chainedCall of statement.chain) {
        result = await this.callMethod(result, chainedCall.method, chainedCall.args)
      }
    }
  }

  /**
   * Process transport commands
   */
  private async processTransportStatement(statement: any): Promise<void> {
    // Transport commands can be on global or sequence
    const target = statement.target

    // Check if it's a global
    const global = this.globals.get(target)
    if (global) {
      await this.callMethod(global, statement.command, [])
      return
    }

    // Check if it's a sequence
    const sequence = this.sequences.get(target)
    if (sequence) {
      await this.callMethod(sequence, statement.command, [])
      return
    }

    console.error(`Transport target not found: ${target}`)
  }

  /**
   * Call a method on an object with proper argument processing
   */
  private async callMethod(obj: any, methodName: string, args: any[]): Promise<any> {
    const method = obj[methodName]
    if (!method || typeof method !== 'function') {
      console.error(`Method not found: ${methodName} on ${obj.constructor.name}`)
      return obj
    }

    // Process arguments
    const processedArgs = await this.processArguments(methodName, args)

    // Call the method
    const result = await method.apply(obj, processedArgs)

    // Return the result (usually 'this' for chaining)
    return result || obj
  }

  /**
   * Process method arguments
   */
  private async processArguments(methodName: string, args: any[]): Promise<any[]> {
    const processed: any[] = []

    for (const arg of args) {
      if (methodName === 'beat' && arg.numerator !== undefined) {
        // Handle meter: beat(4 by 4) -> beat(4, 4)
        processed.push(arg.numerator, arg.denominator)
      } else if (methodName === 'play') {
        // Play arguments are passed as-is (already PlayElement[])
        processed.push(arg)
      } else {
        // Most arguments are passed through
        processed.push(arg)
      }
    }

    return processed
  }

  /**
   * Get state for testing/debugging
   */
  getState() {
    const state: any = {
      globals: {},
      sequences: {},
    }

    for (const [name, global] of this.globals) {
      state.globals[name] = global.getState()
    }

    for (const [name, sequence] of this.sequences) {
      state.sequences[name] = sequence.getState()
    }

    return state
  }
}

// Export factory function
export function createInterpreter(): InterpreterV2 {
  return new InterpreterV2()
}
