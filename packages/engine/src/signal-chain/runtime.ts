import { Global } from '../core/global'
import type { MixerBusHandle } from '../core/global/mixer-manager'
import type { MixerInit, MixerNodeDecl } from '../parser/types'

export interface MixerRuntimeHandle {
  readonly global: Global
}

export type MixerRuntimeNode =
  | {
      readonly kind: 'output'
      readonly global: Global
      readonly channels: readonly [number, number]
    }
  | {
      readonly kind: 'sum' | 'aux'
      readonly global: Global
      readonly handle: MixerBusHandle
    }

export interface MixerRuntimeRegistry {
  readonly handles: Map<string, MixerRuntimeHandle>
  readonly nodes: Map<string, MixerRuntimeNode>
}

export function createMixerRuntimeRegistry(): MixerRuntimeRegistry {
  return { handles: new Map(), nodes: new Map() }
}

export function registerMixerHandle(
  registry: MixerRuntimeRegistry,
  statement: MixerInit,
  globals: Map<string, Global>,
): MixerRuntimeHandle {
  const global = globals.get(statement.globalVariable)
  if (!global) {
    throw new Error(
      `Mixer base global not found: ${statement.globalVariable} ` +
        `(var ${statement.variableName} = init ${statement.globalVariable}.mixer).`,
    )
  }

  const existing = registry.handles.get(statement.variableName)
  if (existing) {
    if (existing.global !== global) {
      throw new Error(
        `Mixer handle "${statement.variableName}" is already bound to a different Global.`,
      )
    }
    global.declareMixerRuntime()
    return existing
  }

  global.declareMixerRuntime()
  const handle = { global }
  registry.handles.set(statement.variableName, handle)
  return handle
}

export function registerMixerNode(
  registry: MixerRuntimeRegistry,
  statement: MixerNodeDecl,
): MixerRuntimeNode {
  const mixer = registry.handles.get(statement.base)
  if (!mixer) {
    throw new Error(
      `Mixer node "${statement.variableName}" has invalid base "${statement.base}": ` +
        `the base is not a mixer handle.`,
    )
  }

  const existing = registry.nodes.get(statement.variableName)
  if (existing) {
    if (existing.global !== mixer.global || existing.kind !== statement.kind) {
      throw new Error(
        `Mixer node "${statement.variableName}" is already declared as ${existing.kind}; ` +
          `it cannot be redeclared as ${statement.kind}.`,
      )
    }
    if (
      existing.kind === 'output' &&
      (existing.channels[0] !== statement.channels?.[0] ||
        existing.channels[1] !== statement.channels?.[1])
    ) {
      throw new Error(
        `Mixer output "${statement.variableName}" is already declared for channels ` +
          `(${existing.channels.join(', ')}).`,
      )
    }
    return existing
  }

  let node: MixerRuntimeNode
  if (statement.kind === 'output') {
    if (!statement.channels) {
      throw new Error(`Mixer output "${statement.variableName}" requires a channel pair.`)
    }
    mixer.global.declareMixerRuntime()
    node = { kind: 'output', global: mixer.global, channels: statement.channels }
  } else {
    const handle = mixer.global[statement.kind](statement.variableName)
    node = { kind: statement.kind, global: mixer.global, handle }
  }
  registry.nodes.set(statement.variableName, node)
  return node
}

/**
 * Resolve a declared node, or the compatibility master endpoint lazily when this
 * Global has no explicit mixer nodes. The implicit endpoint is deliberately not
 * inserted into the registry: InterpreterState survives separate REPL evals.
 */
export function resolveMixerNode(
  registry: MixerRuntimeRegistry,
  name: string,
  global?: Global,
): MixerRuntimeNode | undefined {
  const explicit = registry.nodes.get(name)
  if (explicit) return explicit
  if (!global || name !== 'master') return undefined

  const hasExplicitNode = [...registry.nodes.values()].some((node) => node.global === global)
  return hasExplicitNode ? undefined : { kind: 'output', global, channels: [1, 2] as const }
}

export function mixerNodeReceiver(node: MixerRuntimeNode): MixerBusHandle | MixerRuntimeNode {
  if (node.kind !== 'output') return node.handle
  if (node.channels[0] !== 1 || node.channels[1] !== 2) {
    throw new Error(
      `Mixer output channels (${node.channels.join(', ')}) are declared but cannot be routed ` +
        `until #484 D4 adds multi-output engine support.`,
    )
  }
  return node
}
