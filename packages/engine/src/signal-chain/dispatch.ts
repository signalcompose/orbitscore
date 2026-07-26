import { Global } from '../core/global'
import { isMixerBusHandle } from '../core/global/mixer-manager'
import type { MixerBusHandle } from '../core/global/mixer-manager'
import { loadPluginCatalog, type PluginCatalogEntry } from '../core/global/plugin-catalog'
import { resolveCatalogSpec } from '../core/global/plugin-resolver'
import { Sequence } from '../core/sequence'
import type { NamedArg } from '../parser/types'
import type { InterpreterState } from '../interpreter/types'

import { normalizeCatalogName, resolveChainName } from './resolve'
import { BUS_DSL_METHODS, GLOBAL_DSL_METHODS, SEQUENCE_DSL_METHODS } from './runtime'

export type ChainDispatch =
  | { kind: 'dsl-method' }
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
    resolveCatalogSpec(methodName, undefined, undefined)
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

  const entries = catalogEntriesForMethod(methodName)
  const resolution = resolveChainName(methodName, {
    dslMethods,
    mixerNames: state.mixers.nodes,
    pluginNames: new Set(entries.length > 0 ? [methodName] : []),
  })

  if (resolution.kind === 'mixer-name') {
    throw new Error(
      `Mixer-name method "${methodName}" is resolved, but routing dispatch arrives in S3 (#517).`,
    )
  }
  if (resolution.kind === 'plugin') return { kind: 'plugin', entries }
  const receiverName = isMixerBusHandle(receiver)
    ? `mixer bus "${receiver.bus}"`
    : ((receiver as any)?.constructor?.name ?? 'receiver')
  throw new Error(`Unknown chain method "${methodName}" on ${receiverName}.`)
}

type PluginArguments = {
  format?: string
  vendor?: string
}

/**
 * Classify every plugin-method argument. This function is deliberately total:
 * every known named-argument class is either consumed or rejected, and every
 * non-named shape is rejected as positional syntax. Nothing can fall through.
 */
function classifyPluginArguments(
  methodName: string,
  args: readonly unknown[],
  state: InterpreterState,
): PluginArguments {
  return args.reduce<PluginArguments>((classified, arg) => {
    if (!arg || typeof arg !== 'object' || (arg as NamedArg).type !== 'named_arg') {
      throw new Error(
        `Plugin method "${methodName}" does not accept positional arguments; ` +
          `all arguments must be named, for example ${methodName}(mix: 0.5).`,
      )
    }

    const named = arg as NamedArg
    switch (named.name) {
      case 'format':
        return { ...classified, format: named.value as string }
      case 'vendor':
        return { ...classified, vendor: named.value as string }
      case 'sidechain': {
        const auxName =
          (named.value as any)?.type === 'ref' ? (named.value as any).name : named.value
        const node = state.mixers.nodes.get(auxName as string)
        if (!node || node.kind !== 'aux') {
          throw new Error(`sidechain: "${auxName}" is not a declared aux mixer node.`)
        }
        throw new Error(`sidechain: is validated, but its routing requires #409.`)
      }
      case 'outs':
        throw new Error(`outs: requires multi-output routing in #408.`)
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
  const { format, vendor } = classifyPluginArguments(methodName, args, state)
  const displayName = entries[0].name
  const spec =
    format !== undefined
      ? `${format}/${displayName}`
      : vendor !== undefined
        ? `${vendor}/${displayName}`
        : displayName
  const resolved = resolveCatalogSpec(spec, undefined, undefined)

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
    if (
      role === 'effect' &&
      error instanceof Error &&
      /one insert|single insert|one slot/i.test(error.message)
    ) {
      throw new Error(`${error.message} S4 (#517 multiple insert support) will lift this limit.`)
    }
    throw error
  }
}
