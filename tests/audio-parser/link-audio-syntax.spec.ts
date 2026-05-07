import { describe, it, expect } from 'vitest'

import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'

/**
 * Step 3.1 (Issue #190 / Epic #187): DSL syntax for LinkAudio.
 *
 * 既存の generic な method-call 経路で受理されることを確認するテスト群。
 * tokenizer / parser には変更を加えていない (`linkAudio` / `output` は
 * IDENTIFIER として通る、 `global.tempo()` 等と同じ method-call 構造)。
 *
 * Note on `init` prefix:
 *   ユーザーレビューで「init global.linkAudio()」 案が出たが、 既存 parser
 *   では `init` は変数宣言専用 (`var x = init GLOBAL` / `var s = init global.seq`)。
 *   既存 conventions に揃えた `global.linkAudio()` 形を採用 (parser 拡張不要)。
 *   `init` prefix が本当に欲しいなら別途 parser 拡張で対応する。
 */
describe('LinkAudio DSL syntax (parser pass-through)', () => {
  describe('global.linkAudio() — Global mode declaration', () => {
    it('should parse global.linkAudio() with no arguments', () => {
      const ir = parseAudioDSL('global.linkAudio()')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'global',
        method: 'linkAudio',
        args: [],
      })
    })

    it('should parse global.linkAudio(48000) with explicit target SR', () => {
      const ir = parseAudioDSL('global.linkAudio(48000)')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'global',
        method: 'linkAudio',
        args: [48000],
      })
    })

    it('should parse global.linkAudio(44100) for non-default SR', () => {
      const ir = parseAudioDSL('global.linkAudio(44100)')
      expect(ir.statements?.[0]).toMatchObject({
        method: 'linkAudio',
        args: [44100],
      })
    })
  })

  describe('seq.output() — channel binding', () => {
    it('should parse seq.output("kick")', () => {
      const ir = parseAudioDSL('seq1.output("kick")')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'output',
        args: ['kick'],
      })
    })

    it('should parse seq.output() with hyphen + underscore in channel name', () => {
      const ir = parseAudioDSL('seq1.output("drum-bus_01")')
      expect(ir.statements?.[0]).toMatchObject({
        method: 'output',
        args: ['drum-bus_01'],
      })
    })

    it('should parse seq.audio().output() chain', () => {
      const ir = parseAudioDSL('seq1.audio("../audio/kick.wav").output("kick")')
      expect(ir.statements).toHaveLength(1)
      expect(ir.statements[0]).toMatchObject({
        type: 'sequence',
        target: 'seq1',
        method: 'audio',
        args: ['../audio/kick.wav'],
        chain: [{ method: 'output', args: ['kick'] }],
      })
    })

    it('should parse seq.output().chop() chain', () => {
      const ir = parseAudioDSL('seq1.output("kick").chop(4)')
      expect(ir.statements?.[0]).toMatchObject({
        method: 'output',
        args: ['kick'],
        chain: [{ method: 'chop', args: [4] }],
      })
    })
  })

  describe('Combined LinkAudio program', () => {
    it('should parse a typical .orbs file with global + per-sequence output', () => {
      const src = `
global.tempo(120)
global.linkAudio()

var s = init global.seq
s.audio("../audio/kick.wav").output("kick")
`
      const ir = parseAudioDSL(src)
      expect(ir.statements.length).toBeGreaterThanOrEqual(3)
      const linkAudioStmt = ir.statements.find((s: any) => s.method === 'linkAudio')
      expect(linkAudioStmt).toMatchObject({
        target: 'global',
        method: 'linkAudio',
        args: [],
      })
      const audioStmt = ir.statements.find(
        (s: any) => s.method === 'audio' && s.chain?.some((c: any) => c.method === 'output'),
      )
      expect(audioStmt).toBeDefined()
    })
  })
})
