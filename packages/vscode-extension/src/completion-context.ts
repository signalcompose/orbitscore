import * as vscode from 'vscode'

/**
 * Tracks what methods have been called in a chain
 */
interface MethodChainContext {
  hasAudio: boolean
  hasChop: boolean
  hasPlay: boolean
  hasBeat: boolean
  hasLength: boolean
  hasTempo: boolean
  hasRun: boolean
  lastMethod: string
}

/**
 * Analyzes the current method chain to determine context
 */
export function analyzeMethodChain(lineText: string, position: number): MethodChainContext {
  const context: MethodChainContext = {
    hasAudio: false,
    hasChop: false,
    hasPlay: false,
    hasBeat: false,
    hasLength: false,
    hasTempo: false,
    hasRun: false,
    lastMethod: '',
  }

  // Extract the chain up to current position
  const textBeforeCursor = lineText.substring(0, position)

  // Find the start of the current statement/chain
  let chainStart = textBeforeCursor.lastIndexOf('var ')
  if (chainStart === -1) {
    chainStart = textBeforeCursor.lastIndexOf('init ')
  }
  if (chainStart === -1) {
    chainStart = 0
  }

  const chainText = textBeforeCursor.substring(chainStart)

  // Check for methods in the chain
  if (chainText.includes('.audio(')) {
    context.hasAudio = true
  }
  if (chainText.includes('.chop(')) {
    context.hasChop = true
  }
  if (chainText.includes('.play(')) {
    context.hasPlay = true
  }
  if (chainText.includes('.beat(')) {
    context.hasBeat = true
  }
  if (chainText.includes('.length(')) {
    context.hasLength = true
  }
  if (chainText.includes('.tempo(')) {
    context.hasTempo = true
  }
  if (chainText.includes('.run(')) {
    context.hasRun = true
  }

  // Find the last method before the cursor
  const methodMatch = chainText.match(/\.(\w+)\([^)]*\)(?!.*\.\w+\([^)]*\))/)
  if (methodMatch && methodMatch[1]) {
    context.lastMethod = methodMatch[1]
  }

  return context
}

/**
 * Get appropriate completions based on context
 */
export function getContextualCompletions(
  context: MethodChainContext,
  isGlobal: boolean = false,
): vscode.CompletionItem[] {
  const completions: vscode.CompletionItem[] = []

  if (isGlobal) {
    // Global object completions
    if (!context.hasTempo) {
      completions.push(createCompletion('tempo', 'Set global tempo', 'tempo(${1:120})'))
    }
    if (!context.hasBeat) {
      completions.push(createCompletion('beat', 'Set time signature', 'beat(${1:4} by ${2:4})'))
    }
    completions.push(createCompletion('tick', 'Set tick resolution', 'tick(${1:4})'))
    completions.push(createCompletion('key', 'Set global key', 'key(${1:C})'))
    completions.push(
      createCompletion('audioPath', 'Set audio file base path', 'audioPath("${1:path/to/audio}")'),
    )
    completions.push(createCompletion('gain', 'Set master volume in dB', 'gain(${1:0})'))
    completions.push(
      createCompletion(
        'compressor',
        'Add compressor effect',
        'compressor(${1:0.5}, ${2:0.5}, ${3:0.01}, ${4:0.1}, ${5:1.0}, ${6:true})',
      ),
    )
    completions.push(
      createCompletion('limiter', 'Add limiter effect', 'limiter(${1:0.99}, ${2:0.01}, ${3:true})'),
    )
    completions.push(
      createCompletion(
        'normalizer',
        'Add normalizer effect',
        'normalizer(${1:1.0}, ${2:0.01}, ${3:true})',
      ),
    )

    // Transport commands always available
    completions.push(createCompletion('run', 'Start all sequences', 'run()'))
    completions.push(createCompletion('loop', 'Loop all sequences', 'loop()'))
    completions.push(createCompletion('stop', 'Stop all sequences', 'stop()'))
  } else {
    // Sequence object completions

    // Configuration methods (can be called anytime)
    if (!context.hasBeat) {
      completions.push(createCompletion('beat', 'Set sequence meter', 'beat(${1:4} by ${2:4})'))
    }
    if (!context.hasLength) {
      completions.push(createCompletion('length', 'Set loop length in bars', 'length(${1:1})'))
    }
    if (!context.hasTempo) {
      completions.push(createCompletion('tempo', 'Set independent tempo', 'tempo(${1:120})'))
    }

    // Audio loading (usually first, but can be called anytime)
    if (!context.hasAudio) {
      completions.push(
        createCompletion('audio', 'Load audio file', 'audio("${1:path/to/file.wav}")'),
      )
    }

    // After audio is loaded
    if (context.hasAudio) {
      if (!context.hasChop) {
        completions.push(createCompletion('chop', 'Slice audio into n parts', 'chop(${1:8})'))
      }
      if (!context.hasPlay) {
        completions.push(
          createCompletion('play', 'Define playback pattern', 'play(${1:1, 0, 1, 0})'),
        )
      }
    }

    // After play is defined
    if (context.hasPlay) {
      completions.push(createCompletion('gain', 'Set volume in dB', 'gain(${1:0})'))
      completions.push(createCompletion('pan', 'Set pan position (-100 to 100)', 'pan(${1:0})'))
    }

    // Transport commands (usually at the end)
    if (context.hasAudio || context.hasPlay) {
      completions.push(createCompletion('run', 'Start this sequence', 'run()'))
      completions.push(createCompletion('loop', 'Loop this sequence', 'loop()'))
      completions.push(createCompletion('stop', 'Stop this sequence', 'stop()'))
      completions.push(createCompletion('mute', 'Mute this sequence', 'mute()'))
      completions.push(createCompletion('unmute', 'Unmute this sequence', 'unmute()'))
    }
  }

  // Sort by relevance/typical order
  return sortCompletionsByRelevance(completions, context)
}

/**
 * Create a completion item
 */
function createCompletion(
  label: string,
  documentation: string,
  insertText: string,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Method)
  item.documentation = new vscode.MarkdownString(documentation)
  item.insertText = new vscode.SnippetString(insertText)
  return item
}

/**
 * Sort completions by typical usage order
 */
function sortCompletionsByRelevance(
  completions: vscode.CompletionItem[],
  context: MethodChainContext,
): vscode.CompletionItem[] {
  const order: { [key: string]: number } = {}

  // Define typical order based on context
  if (!context.hasAudio) {
    // If no audio yet, prioritize audio loading
    order['audio'] = 1
    order['beat'] = 2
    order['length'] = 3
    order['tempo'] = 4
  } else if (context.hasAudio && !context.hasPlay) {
    // After audio, suggest chop or play
    order['chop'] = 1
    order['play'] = 2
    order['beat'] = 3
    order['length'] = 4
  } else if (context.hasPlay && !context.hasRun) {
    // After play, suggest transport or modifiers
    order['run'] = 1
    order['fixpitch'] = 2
    order['time'] = 3
    order['loop'] = 4
    order['mute'] = 5
  }

  return completions.sort((a, b) => {
    const orderA = order[a.label as string] || 99
    const orderB = order[b.label as string] || 99
    return orderA - orderB
  })
}
