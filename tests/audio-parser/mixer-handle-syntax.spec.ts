/**
 * Bare `sum("name")` / `aux("name")` reference syntax (MX.2/MX.3, #459/#453 M3):
 * `sum("drum").effect("GlueComp.clap")`. Distinct from `global.sum(name)` /
 * `global.aux(name)` (the declaration form — a plain GlobalStatement, unaffected by
 * this grammar addition and covered by the existing GlobalStatement parsing tests).
 */

import { describe, it, expect } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

describe('Bare sum()/aux() reference parsing', () => {
  it('parses a chained sum("name").effect(path) as a mixer_handle statement', () => {
    const ir = parseAudioDSL('sum("drum").effect("GlueComp.clap")')
    expect(ir.statements[0]).toMatchObject({
      type: 'mixer_handle',
      kind: 'sum',
      name: 'drum',
      chain: [{ method: 'effect', args: ['GlueComp.clap'] }],
    })
  })

  it('parses a chained aux("name").effect(path) as a mixer_handle statement', () => {
    const ir = parseAudioDSL('aux("rev").effect("Reverb.clap")')
    expect(ir.statements[0]).toMatchObject({
      type: 'mixer_handle',
      kind: 'aux',
      name: 'rev',
      chain: [{ method: 'effect', args: ['Reverb.clap'] }],
    })
  })

  it('parses a bare reference with no chain', () => {
    const ir = parseAudioDSL('sum("drum")')
    expect(ir.statements[0]).toMatchObject({
      type: 'mixer_handle',
      kind: 'sum',
      name: 'drum',
    })
    expect((ir.statements[0] as any).chain).toBeUndefined()
  })

  it('parses global.sum(name) as an ordinary GlobalStatement (declaration form, unaffected)', () => {
    // Parser cannot distinguish global vs. sequence targets at parse time (arbitrary variable
    // names) — it emits `type: 'sequence'` and the interpreter re-labels it at execution via
    // `state.globals`/`state.sequences` (see process-statement.ts). Same as `global.tempo()`.
    const ir = parseAudioDSL('global.sum("drum")')
    expect(ir.statements[0]).toMatchObject({
      type: 'sequence',
      target: 'global',
      method: 'sum',
      args: ['drum'],
    })
  })

  it('parses global.aux(name).effect(path) as a GlobalStatement with a chain', () => {
    const ir = parseAudioDSL('global.aux("rev").effect("Reverb.clap")')
    expect(ir.statements[0]).toMatchObject({
      type: 'sequence',
      target: 'global',
      method: 'aux',
      args: ['rev'],
      chain: [{ method: 'effect', args: ['Reverb.clap'] }],
    })
  })

  it('supports multiple statements mixing declaration and bare-reference forms', () => {
    const ir = parseAudioDSL(
      'global.sum("drum")\nkick.output("drum")\nsum("drum").effect("GlueComp.clap")',
    )
    expect(ir.statements).toHaveLength(3)
    expect(ir.statements[2]).toMatchObject({ type: 'mixer_handle', kind: 'sum', name: 'drum' })
  })
})
