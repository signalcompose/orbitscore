import { Global } from '../core/global'
import { MIXER_BUS_KINDS, isMixerBusHandle } from '../core/global/mixer-manager'
import type { MixerBusHandle } from '../core/global/mixer-manager'
import type { MixerInit, MixerNodeDecl } from '../parser/types'
import type { InterpreterState } from '../interpreter/types'

export const GLOBAL_DSL_METHODS: ReadonlySet<string> = new Set([
  'tempo',
  'beat',
  'key',
  'midiLatency',
  'audioPath',
  'audioDevice',
  // Injected as DSL source by the host, not called only from TypeScript: the
  // extension prepends `global.setDocumentDirectory("...")` to every evaluation
  // so `audio()` resolves relative to the edited file (extension.ts, and the MCP
  // evaluate path mirrors it). It therefore belongs to the Global DSL surface —
  // classifying it as an internal API made the reverse-direction test pass while
  // the runtime path threw `Unknown chain method` on every editor evaluation
  // (regression from #519 S2, found by driving the real app in #523).
  'setDocumentDirectory',
  'linkAudio',
  'effect',
  'instrument',
  'sum',
  'aux',
  'quantize',
  'gain',
  'compressor',
  'limiter',
  'normalizer',
  'start',
  'loop',
  'stop',
])

export const SEQUENCE_DSL_METHODS: ReadonlySet<string> = new Set([
  'quantize',
  'tempo',
  'beat',
  'length',
  'gain',
  'defaultGain',
  'pan',
  'defaultPan',
  'output',
  'send',
  'midi',
  'instrument',
  'effect',
  'hold',
  'voicelead',
  'vl',
  'cell',
  'density',
  'comp',
  'gate',
  'vel',
  'octave',
  'root',
  'audio',
  'chop',
  'play',
  'run',
  'loop',
  'stop',
  'mute',
  'unmute',
])

export const BUS_DSL_METHODS: ReadonlySet<string> = new Set(['effect'])

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

const BUS_UNSUPPORTED_DSL_METHODS: ReadonlySet<string> = new Set([
  ...GLOBAL_DSL_METHODS,
  ...SEQUENCE_DSL_METHODS,
])

function validateBusChainMethods(methods: readonly string[]): void {
  const unsupported = methods.find(
    (method) => !BUS_DSL_METHODS.has(method) && BUS_UNSUPPORTED_DSL_METHODS.has(method),
  )
  if (unsupported) {
    throw new Error(
      `Mixer sum/aux bus DSL method "${unsupported}" is not available: ` +
        `plugin-name methods are supported in S2, while routing tails and send sugar arrive ` +
        `in S3 (#517).`,
    )
  }
}

const BUS_PRODUCER_METHODS: ReadonlySet<string> = new Set(MIXER_BUS_KINDS)

/**
 * Gate the pending methods of a statement's call chain: `methods[0]` is about to
 * be invoked on `receiver`, and the rest follow on each result in turn. Throws
 * for the first method that is not part of the bus vocabulary. Plugin-name
 * methods are valid from S2 and routing/send sugar arrives in S3; ordinary
 * Sequence/Global verbs such as `gain` and `tempo` remain invalid on buses.
 * This guard supplies the actionable staged diagnostic instead of `callMethod`'s
 * generic method-not-found error.
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
      `Mixer handle "${statement.variableName}" is already bound to a different Global; ` +
        `live replacement is staged for S4 (#522).`,
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
          `it cannot be redeclared as ${statement.kind} in v1; live replacement is staged ` +
          `for S4 (#522).`,
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
          `(${statement.channels?.join(', ')}) in v1; live replacement is staged for S4 (#522).`,
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
  // `explicit.global` is always a real Global, so when `global` is undefined
  // this comparison is false for every node — an unresolved owning Global
  // (#523 IMPORTANT 7) must not fall back to matching a name against ANY
  // registered Global, which would silently revert to the pre-SC.4
  // unrestricted lookup and break cross-Global isolation (SC.4).
  const explicit = registry.nodes.get(name)
  if (explicit?.global === global) return explicit
  const stringNode = global ? global.resolveMixerBus(name) : undefined
  if (global && stringNode) {
    const handle = global[stringNode.kind](name)
    return { kind: stringNode.kind, global, handle }
  }
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
