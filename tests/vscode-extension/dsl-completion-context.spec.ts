import { describe, expect, it } from 'vitest'

import {
  detectDslCompletionContext,
  extractDeclaredBusNames,
  extractTopLevelDeclaredNames,
  filterDslCandidates,
} from '../../packages/vscode-extension/src/dsl-completion-context'

describe('detectDslCompletionContext', () => {
  it('detects all four completion surfaces', () => {
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
    expect(detectDslCompletionContext('// seq.output("dr', 17)).toBeNull()
    expect(detectDslCompletionContext('note = "seq.output("', 14)).toBeNull()
    expect(detectDslCompletionContext('// import { x } from "./x.orbs"', 14)).toBeNull()
  })

  it('requires bus-name surfaces to be dotted method calls', () => {
    const bare = 'output("dr'
    expect(detectDslCompletionContext(bare, bare.length)).toBeNull()
    const partial = 'seq.reoutput("dr'
    expect(detectDslCompletionContext(partial, partial.length)).toBeNull()
  })
})

describe('filterDslCandidates', () => {
  it('matches case-insensitive substrings and passes everything for empty input', () => {
    expect(filterDslCandidates(['Kick', 'Snare', 'HiHat'], 'ha')).toEqual(['HiHat'])
    expect(filterDslCandidates(['a', 'b'], '')).toEqual(['a', 'b'])
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
