import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('#625 effect replacement disposition under #628', () => {
  it('routes master, sequence, sum, and aux inserts exclusively through ApplyEffectChain', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-effect-migration-'))
    temporaryDirectories.push(directory)
    const applyEffectChain = vi.fn().mockResolvedValue({
      status: 'applied',
      childPid: 31,
      dropped: [],
    })
    const loadPlugin = vi.fn()
    const replacePlugin = vi.fn()
    const unloadPlugin = vi.fn()
    const global = new Global({
      applyEffectChain,
      loadPlugin,
      replacePlugin,
      unloadPlugin,
      boot: vi.fn(),
      quit: vi.fn(),
      isRunning: true,
    } as any)
    global.setDocumentDirectory(directory)

    await global.effect('./Master.clap')
    await global.sequenceEffect('lead', './Echo.clap')
    await global.sum('drums').effect('./Glue.clap')
    await global.aux('wet').effect('./Verb.clap')

    expect(applyEffectChain).toHaveBeenCalledTimes(4)
    expect(applyEffectChain.mock.calls.map(([request]) => request.bus)).toEqual([
      undefined,
      'seq-bus-0',
      'sum-bus-0',
      'aux-bus-0',
    ])
    expect(loadPlugin).toHaveBeenCalledTimes(0)
    expect(replacePlugin).toHaveBeenCalledTimes(0)
    expect(unloadPlugin).toHaveBeenCalledTimes(0)
  })

  it('keeps the LinkAudio exclusion sticky after an empty rack is applied', async () => {
    const applyEffectChain = vi.fn().mockResolvedValue({
      status: 'applied',
      childPid: null,
      dropped: [],
    })
    const global = new Global({
      applyEffectChain,
      boot: vi.fn(),
      quit: vi.fn(),
      isRunning: true,
    } as any)

    await global.effect([])

    expect(applyEffectChain).toHaveBeenCalledTimes(1)
    expect(() => global.linkAudio()).toThrow('plugin hosting')
  })
})
