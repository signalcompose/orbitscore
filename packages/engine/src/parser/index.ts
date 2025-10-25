/**
 * Parser module exports for the audio-based DSL
 * Based on specification: docs/INSTRUCTION_ORBITSCORE_DSL.md
 */

// Export types
export * from './types'

// Export tokenizer
export { AudioTokenizer } from './tokenizer'

// Export parser utilities
export { ParserUtils } from './parser-utils'

// Export main parser (for backward compatibility)
export { AudioParser, parseAudioDSL } from './audio-parser'
