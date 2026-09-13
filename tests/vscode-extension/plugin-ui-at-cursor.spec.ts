import type { TextEditor } from 'vscode'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pluginUiForAgent = vi.hoisted(() => vi.fn())

vi.mock('../../packages/vscode-extension/src/agent-handlers', () => ({ pluginUiForAgent }))

import { normalizePluginInstanceName } from '../../packages/engine/src/core/global/effect-slot'
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

function fakeEditor(text: string, selection = cursor(text, 'ValhallaRoom')): TextEditor {
  return {
    document: { languageId: 'orbitscore', getText: () => text },
    selection,
  } as unknown as TextEditor
}

describe('resolvePluginUiTargetAtCursor', () => {
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

  it.each([
    ['plain sequence', 'drums.effect("Echo")', 'drums'],
    ['global master', 'global.effect("Echo")', 'master'],
    ['direct sum', 'sum("band").effect("Echo")', 'sum:band'],
    ['global aux', 'global.aux("verb").effect("Echo")', 'aux:verb'],
    ['derived sum', ['var d = mix.sum', 'd.effect("Echo")'].join('\n'), 'sum:d'],
    ['derived aux declared later', ['d.effect("Echo")', 'var d = mix.aux'].join('\n'), 'aux:d'],
  ])('resolves the %s receiver', (_label, text, receiver) => {
    expect(targetAt(text, 'Echo')).toMatchObject({ receiver })
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
