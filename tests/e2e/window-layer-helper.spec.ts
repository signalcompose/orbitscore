import { spawnSync } from 'child_process'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { soloWindowLayer } from './helpers/window-layer'

vi.mock('child_process', () => ({ spawnSync: vi.fn() }))

function mockWindows(windows: readonly { pid: number; layer: number; name: string }[]): void {
  vi.mocked(spawnSync).mockReturnValue({
    pid: 1,
    output: [],
    stdout: windows.map((window) => JSON.stringify(window)).join('\n'),
    stderr: '',
    status: 0,
    signal: null,
  })
}

describe('window-layer observation diagnostics', () => {
  beforeEach(() => vi.mocked(spawnSync).mockReset())

  it('names Screen Recording permission when every observed window name is empty', () => {
    mockWindows([
      { pid: 42, layer: 0, name: '' },
      { pid: 42, layer: 3, name: '' },
    ])

    expect(() => soloWindowLayer(42)).toThrowError(
      /all 2 windows.*empty names.*Screen Recording permission.*"layer":3/s,
    )
  })

  it('includes the unfiltered observations when the named-window count is ambiguous', () => {
    mockWindows([
      { pid: 42, layer: 0, name: '' },
      { pid: 42, layer: 3, name: 'Editor' },
      { pid: 42, layer: 0, name: 'Popup' },
    ])

    expect(() => soloWindowLayer(42)).toThrowError(
      /got 2.*Named windows:.*Editor.*Popup.*Unfiltered windows:.*"name":""/s,
    )
  })
})
