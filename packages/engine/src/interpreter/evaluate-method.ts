import { Global } from '../core/global'
import { isMixerBusHandle } from '../core/global/mixer-manager'
import type { MixerBusHandle } from '../core/global/mixer-manager'
import { loadPluginCatalog, type PluginCatalogEntry } from '../core/global/plugin-catalog'
import { Sequence } from '../core/sequence'
import { normalizeCatalogName, resolveChainName } from '../signal-chain/resolve'
import { BUS_DSL_METHODS, GLOBAL_DSL_METHODS, SEQUENCE_DSL_METHODS } from '../signal-chain/runtime'

import type { InterpreterState } from './types'

/**
 * Method evaluation for Interpreter V2
 * Handles method calls and argument processing
 */

/**
 * Call a method on an object with proper argument processing
 *
 * Executes a method on the given object with processed arguments,
 * supporting method chaining by returning the result or the original object.
 *
 * @param obj - Target object (Global or Sequence)
 * @param methodName - Method name to call
 * @param args - Raw arguments from parser
 * @returns Method result or original object for chaining
 *
 * @example
 * ```typescript
 * const result = await callMethod(global, 'tempo', [120])
 * // result === global (for chaining)
 * ```
 */
export async function callMethod(
  obj: any,
  methodName: string,
  args: any[],
  state?: InterpreterState,
): Promise<any> {
  if (state) {
    const dslMethods =
      obj instanceof Sequence
        ? SEQUENCE_DSL_METHODS
        : obj instanceof Global
          ? GLOBAL_DSL_METHODS
          : isMixerBusHandle(obj)
            ? BUS_DSL_METHODS
            : new Set<string>()
    const catalog = loadPluginCatalog()
    const entries =
      catalog?.plugins.filter((entry) => normalizeCatalogName(entry.name) === methodName) ?? []
    const mixerNames = new Set(state.mixers.nodes.keys())
    const resolution = resolveChainName(methodName, {
      dslMethods,
      mixerNames,
      pluginNames: new Set(entries.length > 0 ? [methodName] : []),
    })

    if (resolution.kind === 'mixer-name') {
      throw new Error(
        `Mixer-name method "${methodName}" is resolved, but routing dispatch arrives in S3 (#517).`,
      )
    }
    if (resolution.kind === 'plugin') {
      return dispatchPlugin(obj, methodName, args, entries, state)
    }
    if (resolution.kind === 'unknown') {
      throw new Error(
        `Unknown chain method "${methodName}" on ${obj?.constructor?.name ?? 'receiver'}.`,
      )
    }
  }

  const processedArgs = await processArguments(methodName, args)
  const method = obj[methodName]
  if (!method || typeof method !== 'function') {
    throw new Error(`Method not found: ${methodName} on ${obj?.constructor?.name ?? 'receiver'}`)
  }

  // Call the method
  const result = await method.apply(obj, processedArgs)

  // Return the result (usually 'this' for chaining)
  return result || obj
}

type NamedArg = { type: 'named_arg'; name: string; value: any }

function selector(args: any[], name: string): string | undefined {
  const match = args.find((arg): arg is NamedArg => arg?.type === 'named_arg' && arg.name === name)
  return match?.value
}

function selectCatalogEntries(entries: PluginCatalogEntry[], format?: string, vendor?: string) {
  const normalized = (value: string) => value.trim().normalize('NFC').toLowerCase()
  return entries.filter(
    (entry) =>
      (format === undefined || normalized(entry.format) === normalized(format)) &&
      (vendor === undefined || normalized(entry.vendor) === normalized(vendor)),
  )
}

async function dispatchPlugin(
  obj: any,
  methodName: string,
  args: any[],
  entries: PluginCatalogEntry[],
  state: InterpreterState,
): Promise<any> {
  const format = selector(args, 'format')
  const vendor = selector(args, 'vendor')
  const candidates = selectCatalogEntries(entries, format, vendor)
  if (candidates.length === 0) {
    throw new Error(
      `Plugin "${methodName}" has no catalog entry matching the requested format/vendor selector.`,
    )
  }

  for (const arg of args) {
    if (!arg || arg.type !== 'named_arg' || arg.name === 'format' || arg.name === 'vendor') continue
    if (arg.name === 'sidechain') {
      const auxName = arg.value?.type === 'ref' ? arg.value.name : arg.value
      const node = state.mixers.nodes.get(auxName)
      if (!node || node.kind !== 'aux') {
        throw new Error(`sidechain: "${auxName}" is not a declared aux mixer node.`)
      }
      throw new Error(`sidechain: is validated, but its routing requires #409.`)
    }
    if (arg.name === 'outs') throw new Error(`outs: requires multi-output routing in #408.`)
    throw new Error(
      `named argument "${arg.name}:" requires S4 (#517 Rust param-set/preset/bypass support).`,
    )
  }

  const roles = new Set(candidates.flatMap((entry) => entry.roles))
  let role: 'effect' | 'instrument'
  if (isMixerBusHandle(obj) || obj instanceof Global) {
    role = 'effect'
  } else if (obj instanceof Sequence) {
    if (roles.has('effect') && roles.has('instrument')) {
      const displayName = candidates[0].name
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
    throw new Error(`Plugin "${candidates[0].name}" does not support the "${role}" role.`)
  }

  const displayName = candidates[0].name
  const spec =
    format !== undefined
      ? `${format}/${displayName}`
      : vendor !== undefined
        ? `${vendor}/${displayName}`
        : displayName
  try {
    const result =
      role === 'instrument'
        ? await (obj as Sequence).instrument(spec)
        : await (obj as Global | Sequence | MixerBusHandle).effect(spec)
    return result || obj
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

/**
 * Process method arguments
 *
 * Transforms raw parser arguments into the format expected by methods.
 * Handles special cases like meter notation (4 by 4) and play patterns.
 *
 * @param methodName - Method name being called
 * @param args - Raw arguments from parser
 * @returns Processed arguments ready for method call
 *
 * @example
 * ```typescript
 * // Meter notation: beat(4 by 4) -> beat(4, 4)
 * const args1 = await processArguments('beat', [{ numerator: 4, denominator: 4 }])
 * // args1 === [4, 4]
 *
 * // Play pattern: play(1, 2, 3) -> play([1, 2, 3])
 * const args2 = await processArguments('play', [[1, 2, 3]])
 * // args2 === [[1, 2, 3]]
 * ```
 */
export async function processArguments(methodName: string, args: any[]): Promise<any[]> {
  const processed: any[] = []

  for (const arg of args) {
    if (arg && typeof arg === 'object' && arg.type === 'named_arg') {
      // Selector arguments belong to plugin resolution in S2. Parameter values
      // require S4's Rust param-set/enumeration protocol. Keep this explicit:
      // SC.3.3 forbids silently ignoring either shape.
      let stage: string
      switch (arg.name) {
        case 'format':
        case 'vendor':
          processed.push(arg)
          continue
        case 'sidechain':
          stage = 'sidechain routing arrives in #409'
          break
        case 'outs':
          stage = 'multi-output routing arrives in #408'
          break
        default:
          stage = 'parameter values require the Rust param-set/enumeration protocol in S4'
      }
      throw new Error(
        `named argument "${arg.name}:" in ${methodName}() is not executable yet: ` +
          `${stage} (#517).`,
      )
    }
    if (methodName === 'beat' && arg.numerator !== undefined) {
      // Handle meter: beat(4 by 4) -> beat(4, 4)
      processed.push(arg.numerator, arg.denominator)
    } else if (methodName === 'beat' && typeof arg === 'number') {
      // ERROR: beat() must use "n by m" syntax, not single number
      throw new Error(
        `beat() requires meter notation: beat(${arg} by 4) instead of beat(${arg})\n` +
          `This is essential for polymeter support where different time signatures create independent bar lengths.`,
      )
    } else if (methodName === 'play') {
      // Play arguments are passed as-is (already PlayElement[])
      processed.push(arg)
    } else {
      // Most arguments are passed through
      processed.push(arg)
    }
  }

  return processed
}
