/**
 * Signal Chain DSL notation layer (#514 Phase B):
 * named arguments (SC.3), mixer declarations (SC.2.1), star import (SC.2.2),
 * and the shared name-resolution module. Execution (Phase C) is out of scope —
 * the new shapes throw explicit not-yet-executable errors, asserted below.
 *
 * Spec: docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md
 */

import { describe, it, expect } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import { processArguments } from '../../packages/engine/src/interpreter/evaluate-method'
import {
  normalizeCatalogName,
  resolveChainName,
} from '../../packages/engine/src/signal-chain/resolve'

describe('named arguments (SC.3)', () => {
  it('parses number / negative / string / boolean / identifier-ref values', () => {
    const ir = parseAudioDSL(
      'kick.HogeComp(threshold: -18, mix: 0.5, preset: "Pluck 01", enabled: false, sidechain: duck)',
    )
    expect(ir.statements[0]).toMatchObject({
      type: 'sequence',
      target: 'kick',
      method: 'HogeComp',
      args: [
        { type: 'named_arg', name: 'threshold', value: -18 },
        { type: 'named_arg', name: 'mix', value: 0.5 },
        { type: 'named_arg', name: 'preset', value: 'Pluck 01' },
        { type: 'named_arg', name: 'enabled', value: false },
        { type: 'named_arg', name: 'sidechain', value: { type: 'ref', name: 'duck' } },
      ],
    })
  })

  it('mixes a positional argument with named ones (send sugar: .verb(0.3, enabled: false))', () => {
    const ir = parseAudioDSL('kick.verb(0.3, enabled: false)')
    expect(ir.statements[0]).toMatchObject({
      method: 'verb',
      args: [0.3, { type: 'named_arg', name: 'enabled', value: false }],
    })
  })

  it('rejects map values with an #408 pointer (outs:)', () => {
    expect(() => parseAudioDSL('lead.Serum(outs: { "kick": bd })')).toThrow(/#408/)
  })

  it('throws an explicit not-yet-executable error when a named arg reaches evaluation', async () => {
    await expect(
      processArguments('HogeComp', [{ type: 'named_arg', name: 'mix', value: 0.5 }]),
    ).rejects.toThrow(/Phase C/)
  })
})

describe('mixer declarations (SC.2.1)', () => {
  it('parses var mix = init global.mixer as mixer_init', () => {
    const ir = parseAudioDSL('var mix = init global.mixer')
    expect(ir.statements[0]).toMatchObject({
      type: 'mixer_init',
      variableName: 'mix',
      globalVariable: 'global',
    })
  })

  it('parses output / sum / aux derivations as mixer_node_decl', () => {
    const ir = parseAudioDSL(
      'var master = mix.output(1, 2)\nvar drums = mix.sum\nvar verb = mix.aux',
    )
    expect(ir.statements).toMatchObject([
      {
        type: 'mixer_node_decl',
        variableName: 'master',
        base: 'mix',
        kind: 'output',
        channels: [1, 2],
      },
      { type: 'mixer_node_decl', variableName: 'drums', base: 'mix', kind: 'sum' },
      { type: 'mixer_node_decl', variableName: 'verb', base: 'mix', kind: 'aux' },
    ])
  })

  it('rejects parenthesized sum/aux in a declaration', () => {
    expect(() => parseAudioDSL('var drums = mix.sum()')).toThrow(/no arguments/)
  })

  it('keeps the existing error for other identifier RHS', () => {
    expect(() => parseAudioDSL('var x = someVar')).toThrow(/Expected INIT/)
  })
})

describe('star import (SC.2.2, decision #72)', () => {
  it('parses import * from as a star file_import', () => {
    const ir = parseAudioDSL('import * from "./mod/mixer.orbs"')
    expect(ir.fileImports![0]).toMatchObject({
      type: 'file_import',
      names: [],
      path: './mod/mixer.orbs',
      star: true,
    })
  })

  it('keeps path validation on the star form', () => {
    expect(() => parseAudioDSL('import * from "mixer.orbs"')).toThrow(/relative/)
  })
})

describe('chain notation (SC.0 / SC.4)', () => {
  it('parses the SC.0 track example: plugins, named args, send sugar, bare bus tail', () => {
    const ir = parseAudioDSL(
      'kick.audioPath("kick.wav").chop(16).play(1, 5, 9, 13)\n' +
        '    .CLAPTestEffect(mix: 0.5)\n' +
        '    .HogeComp(threshold: -18, sidechain: duck)\n' +
        '    .verb(0.3)\n' +
        '    .FugaEQ(low: 2)\n' +
        '    .drums',
    )
    const statement = ir.statements[0] as { chain: Array<{ method: string; args: unknown[] }> }
    expect(statement).toMatchObject({ type: 'sequence', target: 'kick', method: 'audioPath' })
    expect(statement.chain.map((c) => c.method)).toEqual([
      'chop',
      'play',
      'CLAPTestEffect',
      'HogeComp',
      'verb',
      'FugaEQ',
      'drums',
    ])
    expect(statement.chain[6]).toMatchObject({ method: 'drums', args: [] })
  })

  it('throws an explicit not-yet-executable error for mixer declarations at interpretation', async () => {
    const { processStatement } = await import(
      '../../packages/engine/src/interpreter/process-statement'
    )
    const statement = parseAudioDSL('var mix = init global.mixer').statements[0]!
    await expect(
      processStatement(statement, { globals: new Map(), sequences: new Map() } as never),
    ).rejects.toThrow(/Phase C/)
  })
})

describe('shared name resolution (SC.2 norm 3 / SC.3.2)', () => {
  it('normalizes catalog names to method form', () => {
    expect(normalizeCatalogName('TAL Reverb 4')).toBe('TALReverb4')
    expect(normalizeCatalogName('4U Comp')).toBe('_4UComp')
    expect(normalizeCatalogName('***')).toBeNull()
  })

  it('resolves with DSL-method > mixer-name > plugin priority and reports collisions', () => {
    const tables = {
      dslMethods: new Set(['play', 'effect']),
      mixerNames: new Set(['drums', 'play']),
      pluginNames: new Set(['TALReverb4', 'drums']),
    }
    expect(resolveChainName('play', tables)).toEqual({
      kind: 'dsl-method',
      collisions: ['mixer-name'],
    })
    expect(resolveChainName('drums', tables)).toEqual({
      kind: 'mixer-name',
      collisions: ['plugin'],
    })
    expect(resolveChainName('TALReverb4', tables)).toEqual({ kind: 'plugin', collisions: [] })
    expect(resolveChainName('nope', tables)).toEqual({ kind: 'unknown', collisions: [] })
  })
})
