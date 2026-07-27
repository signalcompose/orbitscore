import { Global } from '../core/global'
import { EffectSlotLimitError } from '../core/global/effect-slot'
import { isMixerBusHandle } from '../core/global/mixer-manager'
import type { MixerBusHandle } from '../core/global/mixer-manager'
import { loadPluginCatalog, type PluginCatalogEntry } from '../core/global/plugin-catalog'
import { resolveCatalogMethodCandidates, resolveCatalogSpec } from '../core/global/plugin-resolver'
import { Sequence } from '../core/sequence'
import type { NamedArg } from '../parser/types'
import type { InterpreterState } from '../interpreter/types'

import { normalizeCatalogName, resolveChainName } from './resolve'
import {
  BUS_DSL_METHODS,
  GLOBAL_DSL_METHODS,
  SEQUENCE_DSL_METHODS,
  resolveMixerNode,
} from './runtime'

export type ChainDispatch =
  | { kind: 'dsl-method' }
  | { kind: 'mixer'; node: import('./runtime').MixerRuntimeNode }
  | { kind: 'plugin'; entries: PluginCatalogEntry[] }

const catalogMethodIndexes = new WeakMap<
  object,
  ReadonlyMap<string, readonly PluginCatalogEntry[]>
>()

function catalogEntriesForMethod(methodName: string): PluginCatalogEntry[] {
  const catalog = loadPluginCatalog()
  // Reuse the catalog resolver's canonical missing-catalog diagnostic instead
  // of collapsing absence into the same empty result as a misspelled name.
  if (!catalog) {
    try {
      resolveCatalogSpec(methodName, undefined, undefined)
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`${error.message} Also check the DSL method name for a typo.`)
      }
      throw error
    }
    throw new Error('Plugin catalog resolution unexpectedly returned without a catalog.')
  }

  let index = catalogMethodIndexes.get(catalog)
  if (!index) {
    const mutable = new Map<string, PluginCatalogEntry[]>()
    for (const entry of catalog.plugins) {
      const normalizedName = normalizeCatalogName(entry.name)
      if (normalizedName === null) continue
      const matching = mutable.get(normalizedName)
      if (matching) matching.push(entry)
      else mutable.set(normalizedName, [entry])
    }
    index = mutable
    catalogMethodIndexes.set(catalog, index)
  }
  return [...(index.get(methodName) ?? [])]
}

export function resolveChainDispatch(
  receiver: unknown,
  methodName: string,
  state: InterpreterState,
  invocation: 'bare' | 'call' = 'call',
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
  const entries = catalogEntriesForMethod(methodName)
  const resolution = resolveChainName(methodName, {
    dslMethods,
    mixerNames: {
      // `resolveChainName` queries this with the same name it was handed
      // (resolve.ts:61), so the node resolved above already is the answer.
      // Re-resolving would rebuild a mixer-bus handle just to discard it.
      has: () => node !== undefined,
    },
    pluginNames: new Set(entries.length > 0 ? [methodName] : []),
  })

  if (resolution.kind === 'mixer-name') {
    if (!node) throw new Error(`Mixer node "${methodName}" is not visible from this Global.`)
    return { kind: 'mixer', node }
  }
  if (resolution.kind === 'plugin') {
    if (invocation === 'bare') {
      throw new Error(
        `Plugin method "${methodName}" requires parentheses; write ${methodName}(). ` +
          `Bare names are reserved for mixer output routing.`,
      )
    }
    return { kind: 'plugin', entries }
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

type PluginArguments = {
  format?: string
  vendor?: string
}

type ArgumentShape = 'string literal' | 'identifier' | 'number'

const RESERVED_ARGUMENT_SHAPES = {
  format: 'string literal',
  vendor: 'string literal',
  sidechain: 'identifier',
  outs: 'number',
} as const satisfies Record<string, ArgumentShape>

function argumentShape(value: NamedArg['value']): ArgumentShape | 'boolean' {
  if (typeof value === 'string') return 'string literal'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'identifier'
}

function validateReservedArgumentShape(methodName: string, named: NamedArg): void {
  const expected = RESERVED_ARGUMENT_SHAPES[named.name as keyof typeof RESERVED_ARGUMENT_SHAPES]
  if (expected === undefined || argumentShape(named.value) === expected) return

  const example =
    expected === 'string literal'
      ? `${named.name}: "${named.name === 'format' ? 'vst3' : 'Vendor Name'}"`
      : expected === 'identifier'
        ? `${named.name}: duck`
        : `${named.name}: 4`
  throw new Error(
    `Plugin method "${methodName}" requires ${named.name}: to be a ${expected}; ` +
      `use ${example}.`,
  )
}

/**
 * Classify every plugin-method argument. This function is deliberately total:
 * every known named-argument class is either consumed or rejected, and every
 * non-named shape is rejected as positional syntax. Nothing can fall through.
 *
 * Total by construction, not by discipline. The shape this replaced — handle
 * the cases you thought of, `continue` past the rest — swallowed a case five
 * separate times across #517, each time because a check was re-implemented
 * rather than reused, and each time the gap was invisible until someone tried
 * the input nobody had listed. Extend the `switch` (the `default` arm throws)
 * rather than adding an early branch that can skip an argument.
 */
function classifyPluginArguments(
  receiver: unknown,
  methodName: string,
  args: readonly unknown[],
  state: InterpreterState,
): PluginArguments {
  const seen = new Set<string>()
  return args.reduce<PluginArguments>((classified, arg) => {
    if (!arg || typeof arg !== 'object' || (arg as NamedArg).type !== 'named_arg') {
      throw new Error(
        `Plugin method "${methodName}" does not accept positional arguments; ` +
          `all arguments must be named, for example ${methodName}(mix: 0.5).`,
      )
    }

    const named = arg as NamedArg
    if (seen.has(named.name)) {
      throw new Error(
        `Plugin method "${methodName}" specifies duplicate named argument "${named.name}:".`,
      )
    }
    seen.add(named.name)
    validateReservedArgumentShape(methodName, named)

    switch (named.name) {
      case 'format':
        return { ...classified, format: named.value as string }
      case 'vendor':
        return { ...classified, vendor: named.value as string }
      case 'sidechain': {
        const auxName = (named.value as { type: 'ref'; name: string }).name
        const global = resolveReceiverGlobal(receiver, state)
        const node = resolveMixerNode(state.mixers, auxName, global)
        if (!node || node.kind !== 'aux') {
          throw new Error(`sidechain: "${auxName}" is not a declared aux mixer node.`)
        }
        throw new Error(`sidechain: is validated, but its routing requires #409.`)
      }
      case 'outs':
        throw new Error(`outs: requires multi-output routing in #409.`)
      default:
        throw new Error(
          `named argument "${named.name}:" requires S4 (#517 Rust param-set/preset/bypass support).`,
        )
    }
  }, {})
}

export async function dispatchPlugin(
  receiver: unknown,
  methodName: string,
  args: any[],
  entries: PluginCatalogEntry[],
  state: InterpreterState,
): Promise<any> {
  const { format, vendor } = classifyPluginArguments(receiver, methodName, args, state)
  const resolved = resolveCatalogMethodCandidates(methodName, entries, format, vendor, undefined)
  const displayName = resolved.entry.name
  const spec =
    format !== undefined
      ? `${format}/${displayName}`
      : vendor !== undefined
        ? `${vendor}/${displayName}`
        : displayName

  const roles = new Set(resolved.entries.flatMap((entry) => entry.roles))
  let role: 'effect' | 'instrument'
  if (isMixerBusHandle(receiver) || receiver instanceof Global) {
    role = 'effect'
  } else if (receiver instanceof Sequence) {
    if (roles.has('effect') && roles.has('instrument')) {
      throw new Error(
        `Plugin "${displayName}" is ambiguous between effect and instrument roles; ` +
          `use effect("${displayName}") or instrument("${displayName}") explicitly.`,
      )
    }
    role = roles.has('instrument') ? 'instrument' : 'effect'
  } else {
    throw new Error(`Plugin method "${methodName}" cannot be applied to this receiver.`)
  }
  if (!roles.has(role)) {
    throw new Error(`Plugin "${displayName}" does not support the "${role}" role.`)
  }

  try {
    const result =
      role === 'instrument'
        ? await (receiver as Sequence).instrument(spec)
        : await (receiver as Global | Sequence | MixerBusHandle).effect(spec)
    return result || receiver
  } catch (error) {
    // EffectChainMap は PR-1a でも上限 1 を typed error で報告する。
    if (role === 'effect' && error instanceof EffectSlotLimitError) {
      throw new Error(`${error.message} S4 (#517 multiple insert support) will lift this limit.`)
    }
    throw error
  }
}
