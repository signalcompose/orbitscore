import { Global } from '../core/global'
import type { MixerBusHandle } from '../core/global/mixer-manager'
import type { MixerInit, MixerNodeDecl } from '../parser/types'

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
  /** Mixer handles (`var mix = init global.mixer`) → the console they name. */
  readonly handles: Map<string, Global>
  readonly nodes: Map<string, MixerRuntimeNode>
}

export function createMixerRuntimeRegistry(): MixerRuntimeRegistry {
  return { handles: new Map(), nodes: new Map() }
}

export function registerMixerHandle(
  registry: MixerRuntimeRegistry,
  statement: MixerInit,
  globals: Map<string, Global>,
): Global {
  const global = globals.get(statement.globalVariable)
  if (!global) {
    throw new Error(
      `Mixer base global not found: ${statement.globalVariable} ` +
        `(var ${statement.variableName} = init ${statement.globalVariable}.mixer).`,
    )
  }

  const existing = registry.handles.get(statement.variableName)
  if (existing && existing !== global) {
    throw new Error(
      `Mixer handle "${statement.variableName}" is already bound to a different Global.`,
    )
  }

  // SC.2 norm 1: the console is one, so re-evaluation is an idempotent re-bind.
  global.declareMixerRuntime()
  registry.handles.set(statement.variableName, global)
  return global
}

export function registerMixerNode(
  registry: MixerRuntimeRegistry,
  statement: MixerNodeDecl,
): MixerRuntimeNode {
  const mixerGlobal = registry.handles.get(statement.base)
  if (!mixerGlobal) {
    throw new Error(
      `Mixer node "${statement.variableName}" has invalid base "${statement.base}": ` +
        `the base is not a mixer handle.`,
    )
  }

  const existing = registry.nodes.get(statement.variableName)
  if (existing) {
    if (existing.global !== mixerGlobal || existing.kind !== statement.kind) {
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
    // `channels` is optional on the AST but the parser always populates it for
    // `output`; the guard keeps the narrowing honest rather than casting.
    if (!statement.channels) {
      throw new Error(`Mixer output "${statement.variableName}" requires a channel pair.`)
    }
    mixerGlobal.declareMixerRuntime()
    node = { kind: 'output', global: mixerGlobal, channels: statement.channels }
  } else {
    // Deliberately goes through the same `Global.sum()` / `Global.aux()` the
    // string form uses, so both syntaxes share one bus identity and one gate.
    const handle = mixerGlobal[statement.kind](statement.variableName)
    node = { kind: statement.kind, global: mixerGlobal, handle }
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

  for (const node of registry.nodes.values()) {
    if (node.global === global) return undefined
  }
  return { kind: 'output', global, channels: [1, 2] as const }
}

/**
 * The object a mixer node exposes as a statement receiver.
 *
 * Only sum/aux buses have one in v1: they are real daemon buses that already
 * accept inserts. Output endpoints — including the implicit `master(1, 2)` —
 * have no receiver surface at any channel pair, because routing to a physical
 * output is what #484 D4 adds. Throwing for every output keeps the unimplemented
 * path loud (SC.3.3 forbids swallowing it) instead of handing back an inert
 * object that `callMethod` would silently no-op on.
 */
export function mixerNodeReceiver(node: MixerRuntimeNode): MixerBusHandle {
  if (node.kind !== 'output') return node.handle
  throw new Error(
    `Mixer output endpoints (channels ${node.channels.join(', ')}) cannot receive methods yet: ` +
      `routing to a physical output lands with #484 D4.`,
  )
}
