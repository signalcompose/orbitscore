/**
 * Type definitions for Interpreter V2
 */

import { Global } from '../core/global'
import { Sequence } from '../core/sequence'
import { SuperColliderPlayer } from '../audio/supercollider-player'

/**
 * Interpreter state containing globals and sequences
 */
export interface InterpreterState {
  globals: Map<string, Global>
  sequences: Map<string, Sequence>
  currentGlobal?: Global
  audioEngine: SuperColliderPlayer
  isBooted: boolean
}

/**
 * Options for interpreter initialization
 */
export interface InterpreterOptions {
  audioDevice?: string
}
