import { describe, it, expect } from 'vitest'

import {
  buildDeviceNode,
  buildDeviceSectionNode,
  buildEngineStatusNode,
  buildRootNodes,
  deviceNameFromNodeId,
  deviceSectionChildren,
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

  it('shows stopped state with a start hint', () => {
    expect(buildEngineStatusNode(false)).toEqual({
      kind: 'engine-status',
      id: 'engine-status',
      label: 'Engine: Stopped',
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
    expect(nodes.map((n) => n.kind)).toEqual(['engine-status', 'device-section'])
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

  it('maps each device to a node, marking the system default as selected when nothing is configured', () => {
    const nodes = deviceSectionChildren({ status: 'loaded', devices: [speaker, aggregate] }, '')
    expect(nodes).toEqual([buildDeviceNode(speaker, ''), buildDeviceNode(aggregate, '')])
    expect(nodes[0].selected).toBe(true)
    expect(nodes[1].selected).toBe(false)
  })

  it('marks the explicitly-configured device as selected instead of the host default', () => {
    const nodes = deviceSectionChildren(
      { status: 'loaded', devices: [speaker, aggregate] },
      'Pro Tools Aggregate I/O',
    )
    expect(nodes[0].selected).toBe(false)
    expect(nodes[1].selected).toBe(true)
  })
})

describe('buildDeviceNode', () => {
  it('marks the default device label and description', () => {
    const node = buildDeviceNode(speaker, '')
    expect(node.id).toBe('device:MacBook Proのスピーカー')
    expect(node.label).toContain('(system default)')
    expect(node.label.startsWith('● ')).toBe(true)
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
