/**
 * ラック形のカタログ補完（#628・SC.10.10 規範 1・設計 §3.7c / §5 U1-U3）。
 *
 * 現行の単一行 regex（`detectPluginArgContext`）は `.effect("` の直後でしか
 * 発火しない。ラックは配列・複数行・`layer` の入れ子になるため、そのままでは
 * **移行と同時に補完が退行する**。ここで守るのは「どの文脈で発火するか」と
 * 「どちらの role の候補を出すか」の 2 点。
 */

import { describe, expect, it } from 'vitest'

import {
  detectRackArgContext,
  RACK_SCAN_MAX_LINES,
} from '../../packages/vscode-extension/src/plugin-catalog-completion'

/** `|` をカーソル位置とみなして文書を組み立てる（テストの可読性のため）。 */
function at(source: string) {
  const lines = source.split('\n')
  const line = lines.findIndex((text) => text.includes('|'))
  if (line < 0) throw new Error('テストのソースにカーソル `|` がない')
  const character = lines[line].indexOf('|')
  lines[line] = lines[line].replace('|', '')
  return detectRackArgContext(lines, line, character)
}

describe('detectRackArgContext — どの文脈で発火するか（U1）', () => {
  it('単発の文字列形では従来どおり発火する', () => {
    expect(at('kick.effect("Valh|')).toEqual({
      verb: 'effect',
      typed: 'Valh',
      quoteStartChar: 13,
    })
  })

  it('🔴 ラック配列の中で発火する（単一行 regex が落とす文脈）', () => {
    expect(at('kick.effect(["Valh|')).toMatchObject({ verb: 'effect', typed: 'Valh' })
  })

  it('🔴 複数行にまたがるラックの中で発火する', () => {
    const found = at(['kick.effect([', '  "TAL-Reverb-4",', '  "Valh|'].join('\n'))
    expect(found).toMatchObject({ verb: 'effect', typed: 'Valh' })
  })

  it('🔴 layer の入れ子の中で発火し、role は外側の動詞が決める', () => {
    const found = at(['kick.effect([', '  layer([', '    ["Valh|'].join('\n'))
    expect(found).toMatchObject({ verb: 'effect', typed: 'Valh' })
  })

  it('plugin() の引数でも発火する', () => {
    expect(at('kick.effect([plugin("Pro-|')).toMatchObject({ verb: 'effect', typed: 'Pro-' })
  })

  it('文字列の外では発火しない', () => {
    expect(at('kick.effect([|')).toBeNull()
    expect(at('kick.effect(["A", |')).toBeNull()
  })

  it('閉じた文字列の後ろでは発火しない', () => {
    expect(at('kick.effect(["A")|')).toBeNull()
  })

  it('行内に閉じ引用符があっても、カーソルが文字列の途中なら発火する', () => {
    // 旧 detectPluginArgContext から移設（#463 C3 の owner 要件）。
    expect(at('kick.effect("Val|ue")')).toMatchObject({ verb: 'effect', typed: 'Val' })
  })

  it('ラックと無関係な文字列では発火しない', () => {
    expect(at('drums.audio("kick.w|')).toBeNull()
  })

  it('🔴 閉じ括弧で閉じたラックの外では発火しない（対応が取れている括弧は数える）', () => {
    expect(at('kick.effect(["A"]) // "no|')).toBeNull()
  })
})

describe('detectRackArgContext — role の分離（U2）', () => {
  it('🔴 instrument 配下では instrument になる', () => {
    expect(at('cb.instrument(["Kont|')).toMatchObject({ verb: 'instrument' })
  })

  it('🔴 instrument(layer([ の中でも instrument のまま', () => {
    const found = at(['cb.instrument(layer([', '  ["Kont|'].join('\n'))
    expect(found).toMatchObject({ verb: 'instrument' })
  })

  it('🔴 effect 配下では effect になる（同じ配列構文でも role が違う）', () => {
    expect(at('kick.effect(["Kont|')).toMatchObject({ verb: 'effect' })
  })
})

describe('detectRackArgContext — 走査の有界性（U3）', () => {
  it('上限行数を超えて遡らない', () => {
    const filler = Array.from({ length: RACK_SCAN_MAX_LINES + 5 }, () => '')
    const found = at(['kick.effect([', ...filler, '  "Valh|'].join('\n'))
    expect(found).toBeNull()
  })

  it('上限のすぐ内側なら到達する', () => {
    const filler = Array.from({ length: RACK_SCAN_MAX_LINES - 2 }, () => '')
    const found = at(['kick.effect([', ...filler, '  "Valh|'].join('\n'))
    expect(found).toMatchObject({ verb: 'effect', typed: 'Valh' })
  })
})

describe('detectRackArgContext — typed と quoteStartChar', () => {
  it('打鍵途中の接頭辞をそのまま返す', () => {
    expect(at('kick.effect(["|')).toMatchObject({ typed: '' })
    expect(at('kick.effect(["Val|')).toMatchObject({ typed: 'Val' })
  })

  it('quoteStartChar は開き引用符の**次**を指す', () => {
    const found = at('kick.effect(["Val|')
    // `kick.effect(["` は 14 文字なので、内容は 14 桁目から始まる
    expect(found?.quoteStartChar).toBe(14)
  })
})
