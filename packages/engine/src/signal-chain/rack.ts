import type { BoundValue } from '../midi/chord/types'
import type {
  NamedArg,
  PlayChordRef,
  StackElement,
  ValueArray,
  ValueCall,
  ValueExpression,
  ValueRef,
} from '../parser/types'

export interface CatalogRackRecipe {
  readonly kind: 'catalog'
  readonly spec: string
  readonly pluginId?: string
  readonly enabled: boolean
  readonly format?: string
  readonly vendor?: string
}

export interface StandardRackRecipe {
  readonly kind: 'standard'
  readonly name: 'Gain'
  readonly params: Readonly<Record<string, number>>
  readonly enabled: boolean
}

export interface LayerRackRecipe {
  readonly kind: 'layer'
  readonly source: ValueCall
}

export type RackRecipeElement = CatalogRackRecipe | StandardRackRecipe | LayerRackRecipe
export type RackRecipe = readonly RackRecipeElement[]

export interface RackBindingEnvironment {
  getBinding(name: string): BoundValue | undefined
  getRack(name: string): RackRecipe | undefined
}

export function isValueArray(value: unknown): value is ValueArray {
  return Boolean(value && typeof value === 'object' && (value as ValueArray).type === 'value_array')
}

export function isValueCall(value: unknown): value is ValueCall {
  return Boolean(value && typeof value === 'object' && (value as ValueCall).type === 'value_call')
}

export function isValueRef(value: unknown): value is ValueRef | PlayChordRef {
  return Boolean(
    value &&
      typeof value === 'object' &&
      ((value as ValueRef).type === 'value_ref' || (value as PlayChordRef).type === 'chord_ref'),
  )
}

function cloneRack(rack: RackRecipe): RackRecipe {
  return structuredClone(rack) as RackRecipe
}

function namedArgs(call: ValueCall): NamedArg[] {
  return call.args.filter((arg): arg is NamedArg =>
    Boolean(arg && typeof arg === 'object' && arg.type === 'named_arg'),
  )
}

function positionalArgs(call: ValueCall): ValueExpression[] {
  return call.args.filter(
    (arg): arg is ValueExpression => !arg || typeof arg !== 'object' || arg.type !== 'named_arg',
  )
}

function oneNamedValue(call: ValueCall, name: string): NamedArg['value'] | undefined {
  const matching = namedArgs(call).filter((arg) => arg.name === name)
  if (matching.length > 1) {
    throw new Error(`${call.name}() specifies duplicate named argument "${name}:".`)
  }
  return matching[0]?.value
}

function expectBoolean(call: ValueCall, name: string, fallback: boolean): boolean {
  const value = oneNamedValue(call, name)
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${call.name}() ${name}: must be boolean.`)
  return value
}

function expectOptionalString(call: ValueCall, name: string): string | undefined {
  const value = oneNamedValue(call, name)
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${call.name}() ${name}: must be a string.`)
  return value
}

function resolvePluginCall(call: ValueCall): CatalogRackRecipe {
  const positional = positionalArgs(call)
  if (positional.length !== 1 || typeof positional[0] !== 'string') {
    throw new Error(
      'plugin() requires exactly one catalog name/path string as its positional argument.',
    )
  }
  const allowed = new Set(['enabled', 'format', 'vendor'])
  const unsupported = namedArgs(call).find((arg) => !allowed.has(arg.name))
  if (unsupported) {
    throw new Error(
      `plugin() argument "${unsupported.name}:" is not available: catalog parameter setting is staged with #522; ` +
        'v1 accepts enabled:, format:, and vendor: only.',
    )
  }
  const format = expectOptionalString(call, 'format')
  const vendor = expectOptionalString(call, 'vendor')
  if (format !== undefined && vendor !== undefined) {
    throw new Error('plugin() accepts either format: or vendor:, not both.')
  }
  return {
    kind: 'catalog',
    spec: positional[0],
    enabled: expectBoolean(call, 'enabled', true),
    ...(format === undefined ? {} : { format }),
    ...(vendor === undefined ? {} : { vendor }),
  }
}

function resolveStandardCall(call: ValueCall): StandardRackRecipe {
  if (call.name !== 'Gain') {
    throw new Error(
      `no standard plugin named "${call.name}"; catalog plugins are written as strings: effect("${call.name}")`,
    )
  }
  if (positionalArgs(call).length > 0) {
    throw new Error('Gain() accepts named arguments only, for example Gain(db: -6).')
  }
  const allowed = new Set(['db', 'enabled'])
  const unsupported = namedArgs(call).find((arg) => !allowed.has(arg.name))
  if (unsupported) throw new Error(`Gain() has no parameter named "${unsupported.name}".`)
  const db = oneNamedValue(call, 'db') ?? 0
  if (typeof db !== 'number' || !Number.isFinite(db)) {
    throw new Error('Gain() db: must be a finite number.')
  }
  return {
    kind: 'standard',
    name: 'Gain',
    params: { db },
    enabled: expectBoolean(call, 'enabled', true),
  }
}

function resolveCall(call: ValueCall, env: RackBindingEnvironment): RackRecipe {
  if (/^[A-Z]/.test(call.name)) return [resolveStandardCall(call)]
  switch (call.name) {
    case 'plugin':
      return [resolvePluginCall(call)]
    case 'chain': {
      const positional = positionalArgs(call)
      if (namedArgs(call).length > 0 || positional.length !== 1 || !isValueArray(positional[0])) {
        throw new Error('chain() requires exactly one array argument.')
      }
      return resolveRackValue(positional[0], env)
    }
    case 'layer':
      return [{ kind: 'layer', source: structuredClone(call) }]
    case 'gain':
      throw new Error(
        'unknown rack word "gain"; the standard gain plugin is capitalized: Gain(db: -6)',
      )
    default:
      throw new Error(
        `unknown rack word "${call.name}"; rack structure words are plugin(), chain(), and layer().`,
      )
  }
}

export function resolveRackValue(value: ValueExpression, env: RackBindingEnvironment): RackRecipe {
  if (typeof value === 'string') {
    return [{ kind: 'catalog', spec: value, enabled: true }]
  }
  if (isValueRef(value)) {
    if (value.octaveShift !== 0) {
      throw new Error(`rack variable "${value.name}" cannot use a chord octave shift (^N).`)
    }
    const rack = env.getRack(value.name)
    if (rack) return cloneRack(rack)
    if (env.getBinding(value.name)?.kind === 'chord') {
      throw new Error(`"${value.name}" is a chord variable, not a rack variable.`)
    }
    if (value.type === 'value_ref' && /^[A-Z]/.test(value.name)) {
      throw new Error(
        `rack variable "${value.name}" not found; did you mean \`${value.name}(...)\`?`,
      )
    }
    throw new Error(`rack variable "${value.name}" not found.`)
  }
  if (isValueCall(value)) return resolveCall(value, env)
  if (isValueArray(value)) {
    if ((value.octaveShift ?? 0) !== 0) {
      throw new Error('rack arrays cannot use a chord octave shift (^N).')
    }
    return value.elements.flatMap((element) => resolveRackValue(element, env))
  }
  throw new Error(
    `rack elements must be catalog strings, rack variables, calls, or arrays; got ${JSON.stringify(value)}.`,
  )
}

function containsRackSyntax(value: ValueExpression): boolean {
  return typeof value === 'string' || isValueCall(value) || isValueArray(value)
}

function chordElement(value: ValueExpression): StackElement {
  if (isValueRef(value)) {
    return { type: 'chord_ref', name: value.name, octaveShift: value.octaveShift }
  }
  if (isValueArray(value)) {
    return {
      type: 'stack',
      voices: value.elements.map(chordElement),
      ...(value.octaveShift === undefined ? {} : { octaveShift: value.octaveShift }),
    }
  }
  return value as StackElement
}

/** Runtime classification for `var x = [...]`; identifier kinds are consulted here, not in the parser. */
export function classifyArrayBinding(
  value: ValueArray,
  env: RackBindingEnvironment,
): { kind: 'chord'; voices: StackElement[] } | { kind: 'rack'; rack: RackRecipe } {
  if (value.elements.some(containsRackSyntax) || value.elements.length === 0) {
    return { kind: 'rack', rack: resolveRackValue(value, env) }
  }
  const refs = value.elements.filter(isValueRef)
  let chordRefs = 0
  let rackRefs = 0
  for (const ref of refs) {
    if (env.getRack(ref.name)) rackRefs += 1
    else if (env.getBinding(ref.name)?.kind === 'chord') chordRefs += 1
    else
      throw new Error(
        `array identifier "${ref.name}" is neither a chord variable nor a rack variable.`,
      )
  }
  const hasChordPrimitives = value.elements.some((element) => !isValueRef(element))
  if (rackRefs > 0 && (chordRefs > 0 || hasChordPrimitives)) {
    throw new Error(
      'array mixes chord variables and rack variables; chord and rack values cannot share one array.',
    )
  }
  if (rackRefs > 0) return { kind: 'rack', rack: resolveRackValue(value, env) }
  return { kind: 'chord', voices: value.elements.map(chordElement) }
}

export function effectArgumentsToRack(
  args: readonly unknown[],
  env: RackBindingEnvironment,
): RackRecipe {
  if (args.length === 0) throw new Error('effect() requires a catalog plugin or rack value.')
  const first = args[0]
  if (typeof first === 'string') {
    if (args.length > 2 || (args[1] !== undefined && typeof args[1] !== 'string')) {
      throw new Error(
        'effect("...") accepts only an optional pluginId string as its second argument.',
      )
    }
    return [
      {
        kind: 'catalog',
        spec: first,
        enabled: true,
        ...(typeof args[1] === 'string' ? { pluginId: args[1] } : {}),
      },
    ]
  }
  if (args.length !== 1 || (!isValueArray(first) && !isValueRef(first) && !isValueCall(first))) {
    throw new Error('effect() expects one rack array, rack variable, or rack value call.')
  }
  return resolveRackValue(first, env)
}

export function instrumentArguments(
  args: readonly unknown[],
  env: RackBindingEnvironment,
): readonly unknown[] {
  const first = args[0]
  if (!isValueArray(first) && !isValueRef(first) && !isValueCall(first)) return args
  if (args.length !== 1) throw new Error('instrument(rack) accepts exactly one rack value.')
  const rack = resolveRackValue(first, env)
  if (rack.some((element) => element.kind === 'layer')) {
    throw new Error(
      'layer() (parallel racks) is staged behind PDC (SC.10.11); v1 supports serial chains only',
    )
  }
  if (rack.length > 1) {
    throw new Error(
      'multiple instruments need layer([...]); a bare array is serial and instruments cannot be chained (SC.10.6)',
    )
  }
  if (rack.length === 0) throw new Error('instrument([]) needs one instrument plugin.')
  const element = rack[0]
  if (element.kind !== 'catalog') {
    throw new Error(
      'instrument() v1 accepts one catalog plugin; standard effect plugins are not instruments.',
    )
  }
  if (!element.enabled)
    throw new Error('disabled instrument rack entries are staged with instrument layers.')
  const spec = element.format
    ? `${element.format}/${element.spec}`
    : element.vendor
      ? `${element.vendor}/${element.spec}`
      : element.spec
  return element.pluginId === undefined ? [spec] : [spec, element.pluginId]
}
