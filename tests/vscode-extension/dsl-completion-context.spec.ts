import { describe, expect, it } from 'vitest'

import {
  detectDslCompletionContext,
  extractDeclaredBusNames,
  extractTopLevelDeclaredNames,
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
