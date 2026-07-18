import { describe, expect, it } from 'vitest'

import {
  detectDslCompletionContext,
  extractDeclaredBusNames,
  extractTopLevelDeclaredNames,
  GLOBAL_METHODS,
  SEQUENCE_METHODS,
} from '../../packages/vscode-extension/src/dsl-completion-context'

describe('detectDslCompletionContext', () => {
  it('detects all six completion surfaces', () => {
    const importNames = 'import { ki } from "./drums.orbs"'
    expect(detectDslCompletionContext(importNames, importNames.indexOf(' }'))).toMatchObject({
      kind: 'import-names',
      typed: 'ki',
      importPath: './drums.orbs',
    })
    const importPath = 'import { kick } from "./dr'
    expect(detectDslCompletionContext(importPath, importPath.length)).toMatchObject({
      kind: 'import-path',
      typed: './dr',
    })
    expect(detectDslCompletionContext('seq.pl', 6)).toEqual({
      kind: 'sequence-methods',
      typed: 'pl',
    })
    expect(detectDslCompletionContext('global.te', 9)).toEqual({
      kind: 'global-methods',
      typed: 'te',
    })
    expect(detectDslCompletionContext('seq.output("dr', 14)).toMatchObject({
      kind: 'sum-name',
      typed: 'dr',
    })
    expect(detectDslCompletionContext('seq.send("re', 12)).toMatchObject({
      kind: 'aux-name',
      typed: 're',
    })
  })

  it('does not trigger from comments or unrelated string literals', () => {
    expect(detectDslCompletionContext('// seq.', 7)).toBeNull()
    expect(detectDslCompletionContext('note = "global."', 15)).toBeNull()
    expect(detectDslCompletionContext('// import { x } from "./x.orbs"', 14)).toBeNull()
  })
})

describe('source extraction', () => {
  it('extracts engine-equivalent top-level declarations without comments', () => {
    expect(
      extractTopLevelDeclaredNames(
        `var global = init GLOBAL // active global\nvar kick = init global.seq\nvar groove = (1, 0)\n// var hidden = init global.seq`,
      ),
    ).toEqual(['global', 'kick', 'groove'])
  })

  it('extracts only declared matching mixer bus names', () => {
    const source = `global.sum("drums")\nglobal.aux("reverb")\n// global.sum("hidden")\nseq.output("not-a-declaration")`
    expect(extractDeclaredBusNames(source, 'sum')).toEqual(['drums'])
    expect(extractDeclaredBusNames(source, 'aux')).toEqual(['reverb'])
  })
})

describe('static API completion lists', () => {
  it('keeps global completions aligned with the public Global DSL API', () => {
    // Regression for #512 audit: the former hand-maintained list offered
    // non-existent output/run and omitted the real start method.
    expect(GLOBAL_METHODS).not.toContain('output')
    expect(GLOBAL_METHODS).not.toContain('run')
    expect(GLOBAL_METHODS).toContain('start')
  })

  it('keeps pitch sequence methods in the completion list', () => {
    // Regression for #512 audit: pitch DSL methods were absent from the
    // original hard-coded list despite being public Sequence API.
    expect(SEQUENCE_METHODS).toContain('midi')
    expect(SEQUENCE_METHODS).toContain('octave')
  })
})
