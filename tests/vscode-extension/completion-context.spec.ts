import { describe, it, expect, vi } from 'vitest'

// Mock the 'vscode' module so this spec runs outside the VS Code host.
// Only the CompletionItem, CompletionItemKind, MarkdownString, and SnippetString
// constructors are exercised by completion-context.ts — the minimal mock below
// is sufficient.
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
  it('recognizes .linkAudio( → hasLinkAudio = true', () => {
    const result = analyzeMethodChain('var global = init GLOBAL.linkAudio(48000)', 42)
    expect(result.hasLinkAudio).toBe(true)
  })

  it('recognizes .output( → hasOutput = true', () => {
    const result = analyzeMethodChain('kick.audio("kick.wav").output("drums")', 38)
    expect(result.hasOutput).toBe(true)
  })

  it('hasLinkAudio is false when .linkAudio( is absent', () => {
    const result = analyzeMethodChain('var global = init GLOBAL.tempo(120)', 35)
    expect(result.hasLinkAudio).toBe(false)
  })

  it('hasOutput is false when .output( is absent', () => {
    const result = analyzeMethodChain('kick.audio("kick.wav").play(1)', 30)
    expect(result.hasOutput).toBe(false)
  })

  it('recognizes multiple methods in chain simultaneously', () => {
    const line = 'kick.audio("kick.wav").play(1, 0).output("drums")'
    const result = analyzeMethodChain(line, line.length)
    expect(result.hasAudio).toBe(true)
    expect(result.hasPlay).toBe(true)
    expect(result.hasOutput).toBe(true)
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
  hasOutput: false,
  hasLinkAudio: false,
  hasQuantize: false,
  lastMethod: '',
}

describe('getContextualCompletions — global context', () => {
  it('includes linkAudio completion when hasLinkAudio is false', () => {
    const items = getContextualCompletions({ ...baseGlobalContext }, true)
    const labels = items.map((i) => i.label as string)
    expect(labels).toContain('linkAudio')
  })

  it('omits linkAudio completion when hasLinkAudio is true (already declared)', () => {
    const items = getContextualCompletions({ ...baseGlobalContext, hasLinkAudio: true }, true)
    const labels = items.map((i) => i.label as string)
    expect(labels).not.toContain('linkAudio')
  })

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
  const baseContext = {
    hasAudio: false,
    hasChop: false,
    hasPlay: false,
    hasBeat: false,
    hasLength: false,
    hasTempo: false,
    hasRun: false,
    hasOutput: false,
    hasLinkAudio: false,
    hasQuantize: false,
    lastMethod: '',
  }

  it('includes output completion when hasAudio=true and hasOutput=false', () => {
    const context = { ...baseContext, hasAudio: true, hasOutput: false }
    const items = getContextualCompletions(context, false)
    const labels = items.map((i) => i.label as string)
    expect(labels).toContain('output')
  })

  it('omits output completion when hasOutput=true (already declared)', () => {
    const context = { ...baseContext, hasAudio: true, hasOutput: true }
    const items = getContextualCompletions(context, false)
    const labels = items.map((i) => i.label as string)
    expect(labels).not.toContain('output')
  })

  it('omits output completion when hasAudio=false (no audio loaded yet)', () => {
    const context = { ...baseContext, hasAudio: false, hasOutput: false }
    const items = getContextualCompletions(context, false)
    const labels = items.map((i) => i.label as string)
    expect(labels).not.toContain('output')
  })

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
