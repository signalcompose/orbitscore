import { Global } from '../core/global'
import { MIXER_BUS_KINDS, isMixerBusHandle } from '../core/global/mixer-manager'
import type { MixerBusHandle } from '../core/global/mixer-manager'
import type { MixerInit, MixerNodeDecl } from '../parser/types'
import type { InterpreterState } from '../interpreter/types'

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

// SC.2 norm 5's DAG validation starts in #517 S3, together with the send and
// output-routing edges that can actually form a cycle. S1 only registers nodes.
export function createMixerRuntimeRegistry(): MixerRuntimeRegistry {
  return { handles: new Map(), nodes: new Map() }
}

const BUS_CHAIN_METHOD = 'effect'

function validateBusChainMethods(methods: readonly string[]): void {
  const unsupported = methods.find((method) => method !== BUS_CHAIN_METHOD)
  if (unsupported) {
    throw new Error(
      `Mixer sum/aux bus method "${unsupported}" is not available in S1: ` +
        `plugin-name methods arrive in S2, while routing tails and send sugar arrive ` +
        `in S3 (#517).`,
    )
  }
}

const BUS_PRODUCER_METHODS: ReadonlySet<string> = new Set(MIXER_BUS_KINDS)

/**
 * Gate the pending methods of a statement's call chain: `methods[0]` is about to
 * be invoked on `receiver`, and the rest follow on each result in turn. Throws
 * for the first method that would land on a mixer sum/aux bus without being
 * supported in S1 (SC.3.3 forbids swallowing it — `callMethod` would otherwise
 * log "Method not found" and hand the receiver back unchanged).
 *
 * The gate is attached to the *value*, not to a call site: `applyMethodChain`
 * calls it before every dispatch, so a new statement handler cannot open this
 * hole again by forgetting to validate. Two branches, in the order a bus can
 * appear:
 *
 * 1. The receiver already *is* a bus (a declared `mix.sum` node, or the handle a
 *    previous `effect()` returned) — validate everything still pending.
 * 2. The receiver is a `Global` and the next call is `sum()`/`aux()`, which is
 *    about to *make* one — validate the tail that will land on it, before the
 *    call allocates a pool slot. Branch 1 alone would still reject the chain,
 *    just one call too late; this branch is what keeps the rejection atomic.
 */
export function guardBusChain(receiver: unknown, methods: readonly string[]): void {
  if (methods.length === 0) return
  if (isMixerBusHandle(receiver)) {
    validateBusChainMethods(methods)
  } else if (receiver instanceof Global && BUS_PRODUCER_METHODS.has(methods[0])) {
    validateBusChainMethods(methods.slice(1))
  }
}

export function registerMixerHandle(state: InterpreterState, statement: MixerInit): Global {
  const global = state.globals.get(statement.globalVariable)
  if (!global) {
    throw new Error(
      `Mixer base global not found: ${statement.globalVariable} ` +
        `(var ${statement.variableName} = init ${statement.globalVariable}.mixer).`,
    )
  }

  const conflictingNamespace = state.globals.has(statement.variableName)
    ? 'global'
    : state.sequences.has(statement.variableName)
      ? 'sequence'
      : undefined
  if (conflictingNamespace) {
    throw new Error(
      `Mixer name "${statement.variableName}" conflicts with the existing ` +
        `${conflictingNamespace} namespace.`,
    )
  }

  if (state.mixers.nodes.has(statement.variableName)) {
    throw new Error(
      `Mixer handle "${statement.variableName}" conflicts with the existing mixer node namespace.`,
    )
  }

  const existing = state.mixers.handles.get(statement.variableName)
  if (existing && existing !== global) {
    throw new Error(
      `Mixer handle "${statement.variableName}" is already bound to a different Global.`,
    )
  }

  // SC.2 norm 1: the console is one, so re-evaluation is an idempotent re-bind.
  global.declareMixerRuntime()
  state.mixers.handles.set(statement.variableName, global)
  return global
}

export function registerMixerNode(
  state: InterpreterState,
  statement: MixerNodeDecl,
): MixerRuntimeNode {
  const mixerGlobal = state.mixers.handles.get(statement.base)
  if (!mixerGlobal) {
    throw new Error(
      `Mixer node "${statement.variableName}" has invalid base "${statement.base}": ` +
        `the base is not a mixer handle.`,
    )
  }

  const conflictingNamespace = state.globals.has(statement.variableName)
    ? 'global'
    : state.sequences.has(statement.variableName)
      ? 'sequence'
      : undefined
  if (conflictingNamespace) {
    throw new Error(
      `Mixer name "${statement.variableName}" conflicts with the existing ` +
        `${conflictingNamespace} namespace.`,
    )
  }

  if (state.mixers.handles.has(statement.variableName)) {
    throw new Error(
      `Mixer node "${statement.variableName}" conflicts with the existing mixer handle namespace.`,
    )
  }

  const existing = state.mixers.nodes.get(statement.variableName)
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
          `(${existing.channels.join(', ')}); cannot redeclare for ` +
          `(${statement.channels?.join(', ')}).`,
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
  state.mixers.nodes.set(statement.variableName, node)
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
 * accept inserts. Output endpoints — including implicit `master` on channels 1–2 —
 * have no receiver surface at any channel pair, because routing to a physical
 * output is what #484 D4 adds. Throwing for every output keeps the unimplemented
 * path loud (SC.3.3 forbids swallowing it) instead of handing back an inert
 * object that `callMethod` would silently no-op on.
 *
 * Which methods the returned bus accepts is not decided here: {@link guardBusChain}
 * decides that for every bus, however it was reached.
 */
export function mixerNodeReceiver(node: MixerRuntimeNode): MixerBusHandle {
  if (node.kind !== 'output') {
    return node.handle
  }
  throw new Error(
    `Mixer output endpoints (channels ${node.channels.join(', ')}) cannot receive methods yet: ` +
      `routing to a physical output lands with #484 D4.`,
  )
}
