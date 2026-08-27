import { Global } from '../core/global'
import { isMixerBusHandle } from '../core/global/mixer-manager'
import { loadPluginCatalog } from '../core/global/plugin-catalog'
import { Sequence } from '../core/sequence'
import type { InterpreterState } from '../interpreter/types'

import { normalizeCatalogName } from './resolve'
import {
  BUS_DSL_METHODS,
  GLOBAL_DSL_METHODS,
  SEQUENCE_DSL_METHODS,
  resolveMixerNode,
} from './runtime'

export type ChainDispatch =
  | { kind: 'dsl-method' }
  | { kind: 'mixer'; node: import('./runtime').MixerRuntimeNode }

export function resolveChainDispatch(
  receiver: unknown,
  methodName: string,
  state: InterpreterState,
  _invocation: 'bare' | 'call' = 'call',
): ChainDispatch {
  const dslMethods =
    receiver instanceof Sequence
      ? SEQUENCE_DSL_METHODS
      : receiver instanceof Global
        ? GLOBAL_DSL_METHODS
        : isMixerBusHandle(receiver)
          ? BUS_DSL_METHODS
          : new Set<string>()

  // SC.2 norm 3: a known DSL method wins without touching the filesystem-backed
  // plugin catalog.
  if (dslMethods.has(methodName)) return { kind: 'dsl-method' }

  const receiverGlobal = resolveReceiverGlobal(receiver, state)
  const node = resolveMixerNode(state.mixers, methodName, receiverGlobal)
  if (node) return { kind: 'mixer', node }

  // Catalog lookup is diagnostic-only. Method-form catalog declarations were withdrawn by SC.10.9.
  const catalog = loadPluginCatalog()
  const matchingEntry = catalog?.plugins.find(
    (entry) => normalizeCatalogName(entry.name) === methodName,
  )
  if (matchingEntry) {
    throw new Error(
      `Catalog plugins are written as strings (SC.10.9): use effect(${JSON.stringify(
        matchingEntry.name,
      )})`,
    )
  }
  const receiverName = isMixerBusHandle(receiver)
    ? `mixer bus "${receiver.bus}"`
    : ((receiver as any)?.constructor?.name ?? 'receiver')
  throw new Error(`Unknown chain method "${methodName}" on ${receiverName}.`)
}

/**
 * Which Global owns this chain receiver — the scope every mixer-name lookup is
 * resolved against (SC.4: a node declared on another Global is not in scope).
 *
 * Kept as one function because both mixer-name resolution and `sidechain:`
 * validation need it; a mixer-bus handle carries no back-reference, so its owner
 * is found by asking each Global whether it owns that bus.
 */
function resolveReceiverGlobal(receiver: unknown, state: InterpreterState): Global | undefined {
  if (receiver instanceof Sequence) return receiver.getGlobal()
  if (receiver instanceof Global) return receiver
  if (isMixerBusHandle(receiver)) {
    return [...state.globals.values()].find((candidate) => candidate.ownsMixerBus(receiver.bus))
  }
  return undefined
}
