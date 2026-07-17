import { describe, it, expect } from 'vitest'

import {
  buildDeviceNode,
  buildDeviceSectionNode,
  buildEngineStatusNode,
  buildRootNodes,
  deviceNameFromNodeId,
  deviceSectionChildren,
  parseSelectAudioDeviceResultLine,
  resolveDeviceClickAction,
  translateSelectAudioDeviceError,
  type EngineViewDevice,
} from '../../packages/vscode-extension/src/engine-view'

// #484 D3 — pure TreeDataProvider data-shaping helpers (no vscode dependency).

const speaker: EngineViewDevice = {
  name: 'MacBook Proのスピーカー',
  isDefault: true,
  maxOutputChannels: 2,
  defaultSampleRate: 48000,
  direction: 'output',
}
const aggregate: EngineViewDevice = {
  name: 'Pro Tools Aggregate I/O',
  isDefault: false,
  maxOutputChannels: 2,
  defaultSampleRate: 48000,
  direction: 'output',
}

describe('buildEngineStatusNode', () => {
  it('shows running state with a stop hint', () => {
    expect(buildEngineStatusNode(true)).toEqual({
      kind: 'engine-status',
      id: 'engine-status',
      label: 'Engine: Running',
      description: 'Click to stop',
      collapsible: false,
    })
  })

  it('shows off state with a start hint', () => {
    expect(buildEngineStatusNode(false)).toEqual({
      kind: 'engine-status',
      id: 'engine-status',
      label: 'Engine: Off',
      description: 'Click to start',
      collapsible: false,
    })
  })
})

describe('buildDeviceSectionNode', () => {
  it('is collapsible', () => {
    expect(buildDeviceSectionNode().collapsible).toBe(true)
  })
})

describe('buildRootNodes', () => {
  it('returns engine-status then device-section', () => {
    const nodes = buildRootNodes(true)
    expect(nodes.map((n) => n.kind)).toEqual(['engine-status', 'debug-toggle', 'device-section'])
  })
})

describe('deviceSectionChildren', () => {
  it('shows a loading placeholder', () => {
    expect(deviceSectionChildren({ status: 'loading' }, '')).toEqual([
      {
        kind: 'device-loading',
        id: 'device-loading',
        label: 'Loading devices…',
        collapsible: false,
      },
    ])
  })

  it('shows an error node', () => {
    expect(deviceSectionChildren({ status: 'error', message: 'daemon not found' }, '')).toEqual([
      {
        kind: 'device-error',
        id: 'device-error',
        label: '⚠️ daemon not found',
        collapsible: false,
      },
    ])
  })

  it('shows an empty placeholder when the device list is empty', () => {
    expect(deviceSectionChildren({ status: 'loaded', devices: [] }, '')).toEqual([
      {
        kind: 'device-empty',
        id: 'device-empty',
        label: 'No audio devices found',
        collapsible: false,
      },
    ])
  })

  it('keeps an empty setting unselected and exposes an explicit System Default row', () => {
    const nodes = deviceSectionChildren({ status: 'loaded', devices: [speaker, aggregate] }, '')
    expect(nodes).toEqual(
      expect.arrayContaining([buildDeviceNode(speaker, ''), buildDeviceNode(aggregate, '')]),
    )
    expect(nodes[0].selected).toBe(false)
    expect(nodes[1].selected).toBe(false)
  })

  it('marks the explicitly-configured device as selected instead of the host default', () => {
    const nodes = deviceSectionChildren(
      { status: 'loaded', devices: [speaker, aggregate] },
      'Pro Tools Aggregate I/O',
    )
    expect(nodes[0].selected).toBe(false)
    expect(nodes[1].selected).toBe(false)
    expect(nodes[2].selected).toBe(true)
  })
})

describe('buildDeviceNode', () => {
  it('labels the default device but does not select it when nothing is configured (D3.5: empty = off)', () => {
    const node = buildDeviceNode(speaker, '')
    expect(node.id).toBe('device:MacBook Proのスピーカー')
    expect(node.label).toContain('(system default)')
    expect(node.label.startsWith('● ')).toBe(false)
    expect(node.selected).toBe(false)
    expect(node.description).toBe('2ch · 48000Hz')
  })

  it('does not mark a non-selected, non-default device', () => {
    const node = buildDeviceNode(aggregate, '')
    expect(node.selected).toBe(false)
    expect(node.label.startsWith('● ')).toBe(false)
    expect(node.label).not.toContain('(system default)')
  })
})

describe('deviceNameFromNodeId', () => {
  it('extracts the device name from a device node id', () => {
    expect(deviceNameFromNodeId('device:Pro Tools Aggregate I/O')).toBe('Pro Tools Aggregate I/O')
  })

  it('returns null for non-device node ids', () => {
    expect(deviceNameFromNodeId('engine-status')).toBeNull()
    expect(deviceNameFromNodeId('device-loading')).toBeNull()
  })
})

describe('resolveDeviceClickAction', () => {
  it('starts when off with a new device', () => {
    expect(resolveDeviceClickAction('A', '', false)).toBe('start')
  })
  it('switches live when on with a different device', () => {
    expect(resolveDeviceClickAction('B', 'A', true)).toBe('live-switch')
  })
  it('deselects and stops when clicking the selected device', () => {
    expect(resolveDeviceClickAction('A', 'A', true)).toBe('deselect-stop')
  })
})

// #484 D2.5 — the `//#selectAudioDevice` meta-line bridge's pure result parsing/translation.

describe('parseSelectAudioDeviceResultLine', () => {
  it('parses an ok result line', () => {
    expect(
      parseSelectAudioDeviceResultLine(
        JSON.stringify({ selectAudioDevice: { ok: true, device: 'Built-in Output' } }),
      ),
    ).toEqual({ ok: true, device: 'Built-in Output' })
  })

  it('parses an error result line', () => {
    expect(
      parseSelectAudioDeviceResultLine(
        JSON.stringify({ selectAudioDevice: { ok: false, error: 'boom' } }),
      ),
    ).toEqual({ ok: false, error: 'boom' })
  })

  it('tolerates surrounding whitespace/newline from the stdout chunk split', () => {
    expect(
      parseSelectAudioDeviceResultLine(
        `  ${JSON.stringify({ selectAudioDevice: { ok: true, device: 'X' } })}\n`,
      ),
    ).toEqual({ ok: true, device: 'X' })
  })

  it('returns undefined for unrelated lines', () => {
    expect(parseSelectAudioDeviceResultLine('🎵 OrbitScore Audio Engine')).toBeUndefined()
    expect(parseSelectAudioDeviceResultLine('{"other":true}')).toBeUndefined()
  })

  it('returns undefined for malformed JSON that happens to mention the key', () => {
    expect(parseSelectAudioDeviceResultLine('{selectAudioDevice: not json}')).toBeUndefined()
  })
})

describe('translateSelectAudioDeviceError', () => {
  it('translates AUDIO_DEVICE_SWITCH_UNAVAILABLE to a Japanese user message', () => {
    expect(translateSelectAudioDeviceError('AUDIO_DEVICE_SWITCH_UNAVAILABLE')).toBe(
      '録音中は切替できません — エンジンを再起動してください',
    )
  })

  it('passes other errors through unchanged', () => {
    expect(translateSelectAudioDeviceError('device not found')).toBe('device not found')
  })

  it('falls back to a generic message when undefined', () => {
    expect(translateSelectAudioDeviceError(undefined)).toBe('live audio device switch failed')
  })
})
