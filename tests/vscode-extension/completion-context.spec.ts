import { describe, it, expect, vi } from 'vitest'

// Mock the 'vscode' module so this spec runs outside the VS Code host.
vi.mock('vscode', () => {
  const CompletionItemKind = { Method: 1 }
  class CompletionItem {
    public documentation: any
    public insertText: any
    constructor(
      public label: string,
      public kind: number,
    ) {}
  }
  class MarkdownString {
    constructor(public value: string) {}
  }
  class SnippetString {
    constructor(public value: string) {}
  }
  return { CompletionItem, CompletionItemKind, MarkdownString, SnippetString }
})

import {
  analyzeMethodChain,
  getContextualCompletions,
} from '../../packages/vscode-extension/src/completion-context'

describe('analyzeMethodChain', () => {
  it('recognizes .quantize( → hasQuantize = true', () => {
    const result = analyzeMethodChain('var global = init GLOBAL.quantize("bar")', 42)
    expect(result.hasQuantize).toBe(true)
  })

  it('hasQuantize is false when .quantize( is absent', () => {
    const result = analyzeMethodChain('var global = init GLOBAL.tempo(120)', 35)
    expect(result.hasQuantize).toBe(false)
  })

  it('recognizes multiple methods in chain simultaneously', () => {
    const line = 'kick.audio("kick.wav").play(1, 0).quantize("off")'
    const result = analyzeMethodChain(line, line.length)
    expect(result.hasAudio).toBe(true)
    expect(result.hasPlay).toBe(true)
    expect(result.hasQuantize).toBe(true)
  })
})

const baseGlobalContext = {
  hasAudio: false,
  hasChop: false,
  hasPlay: false,
  hasBeat: false,
  hasLength: false,
  hasTempo: false,
  hasRun: false,
  hasQuantize: false,
  lastMethod: '',
}

describe('getContextualCompletions — global context', () => {
  it('includes quantize completion by default', () => {
    const items = getContextualCompletions({ ...baseGlobalContext }, true)
    const labels = items.map((i) => i.label as string)
    expect(labels).toContain('quantize')
  })

  it('omits quantize completion when hasQuantize is true', () => {
    const items = getContextualCompletions({ ...baseGlobalContext, hasQuantize: true }, true)
    const labels = items.map((i) => i.label as string)
    expect(labels).not.toContain('quantize')
  })

  it('does not suggest the removed tick or key methods', () => {
    const items = getContextualCompletions({ ...baseGlobalContext }, true)
    const labels = items.map((i) => i.label as string)
    expect(labels).not.toContain('tick')
    expect(labels).not.toContain('key')
  })
})

describe('getContextualCompletions — sequence context', () => {
  const baseContext = { ...baseGlobalContext }

  it('includes quantize completion once hasPlay=true', () => {
    const context = { ...baseContext, hasAudio: true, hasPlay: true }
    const items = getContextualCompletions(context, false)
    const labels = items.map((i) => i.label as string)
    expect(labels).toContain('quantize')
  })

  it('omits quantize completion when hasQuantize=true', () => {
    const context = {
      ...baseContext,
      hasAudio: true,
      hasPlay: true,
      hasQuantize: true,
    }
    const items = getContextualCompletions(context, false)
    const labels = items.map((i) => i.label as string)
    expect(labels).not.toContain('quantize')
  })

  it('does not suggest fixpitch or time as completions on a sequence', () => {
    const context = { ...baseContext, hasAudio: true, hasPlay: true }
    const items = getContextualCompletions(context, false)
    const labels = items.map((i) => i.label as string)
    expect(labels).not.toContain('fixpitch')
    expect(labels).not.toContain('time')
  })
})
