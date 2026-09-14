import type { TextEditor } from 'vscode'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pluginUiForAgent = vi.hoisted(() => vi.fn())

vi.mock('../../packages/vscode-extension/src/agent-handlers', () => ({ pluginUiForAgent }))

import { normalizePluginInstanceName } from '../../packages/engine/src/core/global/effect-slot'
import { parseAudioDSL } from '../../packages/engine/src/parser/audio-parser'
import type { ChordBinding } from '../../packages/engine/src/parser/types'
import { resolveRackValue } from '../../packages/engine/src/signal-chain/rack'
import {
  OPEN_PLUGIN_UI_AT_CURSOR_COMMAND,
  openPluginUiAtCursor,
  openPluginUiAtCursorForAgent,
  pluginUiAddressFor,
  resolvePluginUiTargetAtCursor,
} from '../../packages/vscode-extension/src/plugin-ui-at-cursor'
import { normalizePluginInstanceNameForGuard } from '../../packages/vscode-extension/src/plugin-name-diagnostics'
import * as vscode from '../mocks/vscode'

function positionAt(text: string, needle: string, occurrence = 1, offset = 1) {
  let index = -1
  for (let n = 0; n < occurrence; n += 1) index = text.indexOf(needle, index + 1)
  if (index < 0) throw new Error(`missing occurrence ${occurrence} of ${needle}`)
  const before = text.slice(0, index + offset)
  const lines = before.split('\n')
  return { line: lines.length - 1, character: lines.at(-1)!.length }
}

function cursor(text: string, needle: string, occurrence = 1, offset = 1) {
  const active = positionAt(text, needle, occurrence, offset)
  return { active, anchor: active }
}

function targetAt(text: string, needle: string, occurrence = 1) {
  const result = resolvePluginUiTargetAtCursor(text, cursor(text, needle, occurrence))
  expect(result.ok, result.ok ? undefined : result.message).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.target
}

function engineCatalogOrder(expression: string): string[] {
  const statement = parseAudioDSL(`var rack = ${expression}`).statements[0] as ChordBinding
  return resolveRackValue(statement.value, {
    getBinding: () => undefined,
    getRack: () => undefined,
  }).map((entry) => {
    expect(entry.kind).toBe('catalog')
    if (entry.kind !== 'catalog') throw new Error(`expected catalog entry, got ${entry.kind}`)
    return entry.spec
  })
}

function fakeEditor(text: string, selection = cursor(text, 'ValhallaRoom')): TextEditor {
  return {
    document: { languageId: 'orbitscore', getText: () => text },
    selection,
  } as unknown as TextEditor
}

describe('resolvePluginUiTargetAtCursor', () => {
  it.each([
    {
      label: 'a nested plain array',
      expression: '["Z", ["A", "B"], "C"]',
      names: ['Z', 'A', 'B', 'C'],
    },
    {
      label: 'identically named plugins in a nested plain array',
      expression: '["Echo", ["Echo", "Echo"], "Echo"]',
      names: ['Echo', 'Echo', 'Echo', 'Echo'],
    },
    {
      label: 'deeply nested plain arrays',
      expression: '[["A", ["B"]], "C"]',
      names: ['A', 'B', 'C'],
    },
    {
      label: 'a chain() inside a plain array',
      expression: '["Z", chain(["A", "B"]), "C"]',
      names: ['Z', 'A', 'B', 'C'],
    },
  ])('matches the engine flat index for $label', ({ expression, names }) => {
    expect(engineCatalogOrder(expression)).toEqual(names)

    const text = `drums.effect(${expression})`
    const occurrences = new Map<string, number>()
    const extensionIndexes = names.map((name) => {
      const occurrence = (occurrences.get(name) ?? 0) + 1
      occurrences.set(name, occurrence)
      const address = pluginUiAddressFor(targetAt(text, name, occurrence))
      expect(address.ok, address.ok ? undefined : address.message).toBe(true)
      if (!address.ok) throw new Error(address.message)
      return address.index
    })

    expect(extensionIndexes).toEqual(names.map((_name, index) => index + 1))
  })

  it('addresses the fourth identical plugin after a nested plain array', () => {
    const expression = '["Echo", ["Echo", "Echo"], "Echo"]'
    const engineOrder = engineCatalogOrder(expression)
    const address = pluginUiAddressFor(
      targetAt(`drums.effect(${expression})`, 'Echo', engineOrder.length),
    )

    expect(address).toMatchObject({
      ok: true,
      index: engineOrder.length,
      expectedName: engineOrder.at(-1),
    })
  })

  it('distinguishes three identical names by syntax path', () => {
    const text = 'drums.effect(["Echo", "Echo", "Echo"])'
    expect(targetAt(text, 'Echo', 1)).toMatchObject({ kind: 'effect', chainPath: [0] })
    expect(targetAt(text, 'Echo', 3)).toMatchObject({ kind: 'effect', chainPath: [2] })
  })

  it('counts a standard Gain element but not commas inside calls', () => {
    const withGain = 'drums.effect(["Echo", Gain(db: -6, label: "not a plugin"), "Echo"])'
    expect(targetAt(withGain, 'Echo', 2)).toMatchObject({ chainPath: [2] })

    const withPluginArgs =
      'drums.effect([plugin("Echo", enabled: false), plugin("Room", enabled: true)])'
    expect(targetAt(withPluginArgs, 'Room')).toMatchObject({ chainPath: [1] })
  })

  it('keeps nested layer paths and refuses to flatten them to an index', () => {
    const text = 'drums.effect([Gain(db: -2), layer([["A"], ["X"]])])'
    const target = targetAt(text, 'X')
    expect(target).toMatchObject({ kind: 'effect', chainPath: [1, 1, 0] })
    expect(pluginUiAddressFor(target)).toEqual({
      ok: false,
      message:
        'layer() (parallel racks) is staged behind PDC (SC.10.11); v1 supports serial chains only',
    })
  })

  it('keeps layer() non-serial when its branch contains chain()', () => {
    const text = 'drums.effect([layer([chain(["A", "B"])])])'
    const target = targetAt(text, 'B')
    expect(target).toMatchObject({ kind: 'effect', chainPath: [0, 1] })
    expect(pluginUiAddressFor(target)).toEqual({
      ok: false,
      message:
        'layer() (parallel racks) is staged behind PDC (SC.10.11); v1 supports serial chains only',
    })
  })

  it.each([
    ['plain sequence', 'drums.effect("Echo")', 'drums'],
    ['global master', 'global.effect("Echo")', 'master'],
    ['direct sum', 'sum("band").effect("Echo")', 'sum:band'],
    ['global aux', 'global.aux("verb").effect("Echo")', 'aux:verb'],
    ['derived sum', ['var d = mix.sum', 'd.effect("Echo")'].join('\n'), 'sum:d'],
    ['derived aux declared later', ['d.effect("Echo")', 'var d = mix.aux'].join('\n'), 'aux:d'],
    [
      'core-spec chained output',
      'snare.output(verb, thru: true, db: -6).effect(["Comp"]).output(drums)',
      'snare',
    ],
    ['chained audio', 'kick.audio("k.wav").effect(["Comp"]).output()', 'kick'],
    ['chained gain', 'kick.gain(-6).effect(["Comp"])', 'kick'],
    ['chained global sum', 'global.sum("drum").gain(-3).effect(["Comp"])', 'sum:drum'],
    ['effect followed by output', 'kick.effect(["Comp"]).output(verb)', 'kick'],
  ])('resolves the %s receiver', (_label, text, receiver) => {
    expect(targetAt(text, text.includes('Echo') ? 'Echo' : 'Comp')).toMatchObject({ receiver })
  })

  it('uses the statement origin for every effect() in one method chain', () => {
    const text = 'drums.effect(["A", "B"]).effect(["C"])'
    expect(targetAt(text, 'A')).toMatchObject({ receiver: 'drums' })
    expect(targetAt(text, 'B')).toMatchObject({ receiver: 'drums' })
    expect(targetAt(text, 'C')).toMatchObject({ receiver: 'drums' })
  })

  it('uses the expression after var assignment as the statement origin', () => {
    expect(targetAt('var processed = kick.gain(-6).effect(["Comp"])', 'Comp')).toMatchObject({
      receiver: 'kick',
    })
  })

  it('rejects a declaration whose expression starts with a bare rack word', () => {
    const text = 'var myRack = effect(["Comp"])'

    expect(resolvePluginUiTargetAtCursor(text, cursor(text, 'Comp'))).toMatchObject({
      ok: false,
      reason: 'unresolved-receiver',
    })
  })

  it('describes a genuinely unresolved statement origin without one-line advice', () => {
    const text = ['drums.', 'effect("Echo")'].join('\n')
    const result = resolvePluginUiTargetAtCursor(text, cursor(text, 'Echo'))

    expect(result).toMatchObject({
      ok: false,
      reason: 'unresolved-receiver',
      message:
        'Could not identify the sequence or bus at the start of this line for the selected plugin chain.',
    })
    if (!result.ok) expect(result.message).not.toContain('one line')
  })

  it('maps an instrument to index zero', () => {
    const target = targetAt('lead.instrument("Synth")', 'Synth')
    expect(pluginUiAddressFor(target)).toEqual({
      ok: true,
      receiver: 'lead',
      index: 0,
      expectedName: 'Synth',
    })
  })

  it.each([
    ['not-on-plugin-name', 'drums.effect("Echo")', cursor('drums.effect("Echo")', 'drums')],
    [
      'standard-plugin',
      'drums.effect([Gain(db: -6)])',
      cursor('drums.effect([Gain(db: -6)])', 'Gain'),
    ],
    [
      'state-file',
      'lead.instrument("Synth", "tone.vstpreset")',
      cursor('lead.instrument("Synth", "tone.vstpreset")', 'tone.vstpreset'),
    ],
    [
      'selection-spans-outside',
      'drums.effect(["A", "B"])',
      {
        anchor: positionAt('drums.effect(["A", "B"])', 'A'),
        active: positionAt('drums.effect(["A", "B"])', 'B'),
      },
    ],
    [
      'unresolved-receiver',
      ['drums.', 'effect("Echo")'].join('\n'),
      cursor(['drums.', 'effect("Echo")'].join('\n'), 'Echo'),
    ],
  ] as const)('fails loudly with %s', (reason, text, selection) => {
    expect(resolvePluginUiTargetAtCursor(text, selection)).toMatchObject({ ok: false, reason })
  })

  it('accepts a selection contained in one literal', () => {
    const text = 'drums.effect("ValhallaRoom")'
    const start = positionAt(text, 'ValhallaRoom', 1, 0)
    const end = positionAt(text, 'ValhallaRoom', 1, 'ValhallaRoom'.length)
    expect(resolvePluginUiTargetAtCursor(text, { anchor: start, active: end })).toMatchObject({
      ok: true,
      target: { expectedName: 'ValhallaRoom' },
    })
  })
})

describe('normalization agreement with the engine expected-name guard', () => {
  it.each([
    'ValhallaRoom',
    '~/Library/Audio/Plug-Ins/VST3/GainOracle.vst3',
    './plugins/CLAPTestEffect.clap',
    '/abs/path/Some.component',
    '/abs/path/Mixed.VST3',
    'TAL Software/TAL Reverb 4',
    `./fx/Cafe\u0301.clap`,
    String.raw`C:\\Plugins\\Synth.vst3`,
  ])('matches the engine for %j', (spec) => {
    expect(normalizePluginInstanceNameForGuard(spec)).toBe(normalizePluginInstanceName(spec))
  })
})

describe('command and MCP wiring', () => {
  beforeEach(() => {
    pluginUiForAgent.mockReset()
    vscode.resetRegisteredCommandHandlers()
    vi.restoreAllMocks()
  })

  it('opens exactly the addressed plugin and returns 1-based source coordinates', async () => {
    const text = 'drums.effect(["ValhallaRoom", Gain(db: -6), "ValhallaRoom"])'
    pluginUiForAgent.mockResolvedValue({
      ok: true,
      result: { completion: 'window-opened' },
    })

    const result = await openPluginUiAtCursor(fakeEditor(text, cursor(text, 'ValhallaRoom', 2)))

    expect(pluginUiForAgent).toHaveBeenCalledTimes(1)
    expect(pluginUiForAgent).toHaveBeenCalledWith('open', 'drums', 3, 'ValhallaRoom')
    expect(result).toMatchObject({
      ok: true,
      receiver: 'drums',
      index: 3,
      chain_path: [2],
      normalizedName: 'ValhallaRoom',
      site: { line: 1 },
      completion: 'window-opened',
    })
  })

  it.each([
    ['no editor', undefined],
    [
      'wrong language',
      {
        document: { languageId: 'plaintext', getText: () => '' },
        selection: { active: { line: 0, character: 0 }, anchor: { line: 0, character: 0 } },
      } as unknown as TextEditor,
    ],
    ['not a plugin', fakeEditor('global.tempo(120)', cursor('global.tempo(120)', 'tempo'))],
    [
      'standard plugin',
      fakeEditor('drums.effect([Gain(db: -6)])', cursor('drums.effect([Gain(db: -6)])', 'Gain')),
    ],
    [
      'state file',
      fakeEditor(
        'lead.instrument("Synth", "tone.vstpreset")',
        cursor('lead.instrument("Synth", "tone.vstpreset")', 'tone.vstpreset'),
      ),
    ],
    [
      'selection outside one literal',
      fakeEditor('drums.effect(["A", "B"])', {
        anchor: positionAt('drums.effect(["A", "B"])', 'A'),
        active: positionAt('drums.effect(["A", "B"])', 'B'),
      }),
    ],
    [
      'unresolved receiver',
      fakeEditor(
        ['drums.', 'effect("Echo")'].join('\n'),
        cursor(['drums.', 'effect("Echo")'].join('\n'), 'Echo'),
      ),
    ],
    [
      'parallel layer',
      fakeEditor(
        'drums.effect(layer([["A"], ["B"]]))',
        cursor('drums.effect(layer([["A"], ["B"]]))', 'B'),
      ),
    ],
  ])('reports %s once and never reaches the engine', async (_label, editor) => {
    const showError = vi.spyOn(vscode.window, 'showErrorMessage')
    const result = await openPluginUiAtCursor(editor)

    expect(result.ok).toBe(false)
    expect(showError).toHaveBeenCalledTimes(1)
    expect(pluginUiForAgent).toHaveBeenCalledTimes(0)
  })

  it('reports an engine refusal through the same command result and UI', async () => {
    const text = 'drums.effect("ValhallaRoom")'
    const showError = vi.spyOn(vscode.window, 'showErrorMessage')
    pluginUiForAgent.mockResolvedValue({
      ok: false,
      error: 'engine is not running — start the engine first',
    })

    const result = await openPluginUiAtCursor(fakeEditor(text))

    expect(result).toEqual({ ok: false, error: 'engine is not running — start the engine first' })
    expect(showError).toHaveBeenCalledOnce()
    expect(pluginUiForAgent).toHaveBeenCalledOnce()
  })

  it('delegates the MCP wrapper through the registered command id and returns its result', async () => {
    const expected = {
      ok: true as const,
      receiver: 'drums',
      index: 3,
      chain_path: [2],
      normalizedName: 'Echo',
      site: { line: 1, startCol: 17, endCol: 23 },
    }
    const command = vi.fn().mockResolvedValue(expected)
    vscode.commands.registerCommand(OPEN_PLUGIN_UI_AT_CURSOR_COMMAND, command)
    const execute = vi.spyOn(vscode.commands, 'executeCommand')

    await expect(openPluginUiAtCursorForAgent()).resolves.toBe(expected)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(OPEN_PLUGIN_UI_AT_CURSOR_COMMAND)
    expect(command).toHaveBeenCalledTimes(1)
  })
})
