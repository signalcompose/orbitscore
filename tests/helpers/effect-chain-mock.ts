import * as fs from 'node:fs'

import { vi } from 'vitest'

import type {
  AudioEngine,
  EffectChainApplyRequest,
  EffectChainApplyResult,
  EffectChainPlanStage,
} from '../../packages/engine/src/audio/types'

type LegacyEffectEngine = Pick<AudioEngine, 'loadPlugin' | 'replacePlugin' | 'unloadPlugin'> & {
  applyEffectChain?: AudioEngine['applyEffectChain']
}

/**
 * Compatibility harness for pre-#628 tests that still observe legacy engine spies.
 * Production code always calls ApplyEffectChain; this adapter translates the mock call
 * so those tests can retain their higher-level assertions while the rack tests inspect
 * the real Apply request directly.
 */
export function installEffectChainMock(engine: LegacyEffectEngine) {
  const previousByBus = new Map<string, readonly EffectChainPlanStage[]>()
  const applyEffectChain = vi.fn(
    async (request: EffectChainApplyRequest): Promise<EffectChainApplyResult> => {
      const key = request.bus ?? 'master'
      const previous = previousByBus.get(key) ?? []
      const catalogLoads = request.chain.filter(
        (stage): stage is Extract<EffectChainPlanStage, { op: 'load'; kind: 'catalog' }> =>
          stage.op === 'load' && stage.kind === 'catalog',
      )

      for (const stage of catalogLoads) {
        if (previous.length > 0 && engine.replacePlugin) {
          if (stage.state !== undefined) {
            await engine.replacePlugin(
              stage.path,
              stage.plugin_id,
              'effect',
              request.bus,
              undefined,
              stage.state,
            )
          } else if (request.bus !== undefined) {
            await engine.replacePlugin(stage.path, stage.plugin_id, 'effect', request.bus)
          } else {
            await engine.replacePlugin(stage.path, stage.plugin_id, 'effect')
          }
        } else if (engine.loadPlugin) {
          if (stage.state !== undefined) {
            await engine.loadPlugin(
              stage.path,
              stage.plugin_id,
              'effect',
              request.bus,
              undefined,
              stage.state,
            )
          } else if (request.bus !== undefined) {
            await engine.loadPlugin(stage.path, stage.plugin_id, 'effect', request.bus)
          } else {
            await engine.loadPlugin(stage.path, stage.plugin_id, 'effect')
          }
        }
      }
      if (request.chain.length === 0 && previous.length > 0 && engine.unloadPlugin) {
        await engine.unloadPlugin('effect', request.bus)
      }

      const dropped = []
      for (const saved of request.saveDropped) {
        await fs.promises.writeFile(saved.path, 'state')
        dropped.push({ prevIndex: saved.prev_index, path: saved.path, bytesWritten: 5 })
      }
      previousByBus.set(key, request.chain)
      return { status: 'applied', childPid: 17, dropped }
    },
  )
  engine.applyEffectChain = applyEffectChain
  return applyEffectChain
}
