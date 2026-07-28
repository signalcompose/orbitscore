import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parse } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Global } from '../../packages/engine/src/core/global'
import { Sequence } from '../../packages/engine/src/core/sequence'
import { stateFileNameForIdentity } from '../../packages/engine/src/core/project-state-store'

const temporaryDirectories: string[] = []

function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-plugin-state-'))
  temporaryDirectories.push(directory)
  const audio = {
    isRunning: true,
    startTime: 0,
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
    clearSequenceEvents: vi.fn(),
    reinitializeSequenceTracking: vi.fn(),
    scheduleEvent: vi.fn(),
    scheduleSliceEvent: vi.fn(),
    getAudioDuration: vi.fn(() => 1),
    getMasterGainDb: () => 0,
    loadPlugin: vi.fn().mockResolvedValue({}),
    savePluginState: vi.fn(async (_target, statePath: string) => {
      await fs.promises.writeFile(statePath, Buffer.from('oracle-state'))
      return { path: statePath, bytesWritten: 12 }
    }),
  } as any
  const global = new Global(audio)
  global.setDocumentDirectory(directory)
  const sequence = new Sequence(global, audio)
  sequence.setName('lead')
  return { directory, audio, global, sequence }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('plugin state address resolution and project registration (#562)', () => {
  it('resolves instrument index 0 to SC.5 identity and the daemon instance', async () => {
    const { global } = harness()
    await global.instrument('lead', './Massive-X.clap')

    expect(global.resolvePluginStateTarget('lead', 0)).toEqual({
      identity: {
        receiver: 'lead',
        role: 'instrument',
        normalizedName: 'Massive-X',
        occurrence: 0,
      },
      daemonTarget: { role: 'instrument', instance: 'plugin:lead' },
    })
  })

  it('saves non-empty state then atomically registers the SC.5 key in project.yaml', async () => {
    const { directory, audio, global } = harness()
    await global.instrument('lead', './Massive-X.clap')

    const saved = await global.savePluginState('lead', 0)
    const identity = {
      receiver: 'lead',
      role: 'instrument' as const,
      normalizedName: 'Massive-X',
      occurrence: 0,
    }
    const expectedRelative = `states/${stateFileNameForIdentity(identity)}`
    expect(saved.identityKey).toBe('lead/instrument/Massive-X/0')
    expect(saved.projectStatePath).toBe(expectedRelative)
    expect(audio.savePluginState).toHaveBeenCalledTimes(1)
    expect(audio.savePluginState).toHaveBeenCalledWith(
      { role: 'instrument', instance: 'plugin:lead' },
      path.join(directory, ...expectedRelative.split('/')),
    )
    expect(fs.readFileSync(saved.path, 'utf8')).toBe('oracle-state')
    expect(parse(fs.readFileSync(path.join(directory, 'project.yaml'), 'utf8'))).toEqual({
      version: 1,
      states: { 'lead/instrument/Massive-X/0': expectedRelative },
    })
    expect(fs.readdirSync(directory).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('uses master index 1 and reports valid role/name indices on a loud miss', async () => {
    const { global } = harness()
    await global.effect('./Limiter.vst3')
    expect(global.resolvePluginStateTarget('master', 1)).toEqual({
      identity: {
        receiver: 'master',
        role: 'effect',
        normalizedName: 'Limiter',
        occurrence: 0,
      },
      daemonTarget: { role: 'effect' },
    })
    expect(() => global.resolvePluginStateTarget('master', 0)).toThrow(
      /Valid indices: 1 \(effect, Limiter\)/,
    )
  })

  it('does not expose the built-in audio source at sequence index 0', () => {
    const { global, sequence } = harness()
    sequence.audio('./kick.wav')

    expect(() => global.resolvePluginStateTarget('lead', 0)).toThrow(
      /built-in audio source is not a plugin.*Valid indices: <none>/,
    )
  })

  it('does not update project.yaml when the daemon state save fails', async () => {
    const { directory, audio, global } = harness()
    await global.instrument('lead', './Massive-X.clap')
    fs.writeFileSync(
      path.join(directory, 'project.yaml'),
      'version: 1\nstates:\n  old/effect/state/0: states/old.state\n',
    )
    audio.savePluginState.mockRejectedValueOnce(new Error('plugin refused state'))

    await expect(global.savePluginState('lead', 0)).rejects.toThrow('plugin refused state')
    expect(fs.readFileSync(path.join(directory, 'project.yaml'), 'utf8')).toContain(
      'old/effect/state/0',
    )
    expect(fs.readFileSync(path.join(directory, 'project.yaml'), 'utf8')).not.toContain(
      'lead/instrument',
    )
  })

  it('rejects on the TS side while transport is running without calling the daemon', async () => {
    const { audio, global } = harness()
    await global.instrument('lead', './Massive-X.clap')
    global.start()

    await expect(global.savePluginState('lead', 0)).rejects.toThrow('transport is running')
    expect(audio.savePluginState).not.toHaveBeenCalled()
    expect(audio.stop).not.toHaveBeenCalled()
  })
})
