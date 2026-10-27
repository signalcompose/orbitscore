import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import {
  createReceiverSchema,
  registerProtocolSchemaKeywords,
  type JsonSchema,
} from '@orbitscore/protocol'

import { loadSessionSchema } from './session-schema'

type SchemaObject = Record<string, any>

const senderSchema = loadSessionSchema() as unknown as SchemaObject
const receiverSchema = createReceiverSchema(senderSchema)
const schemaId = senderSchema.$id as string

function validatorsFor(schema: SchemaObject): (definition: string) => ValidateFunction {
  const ajv = registerProtocolSchemaKeywords(
    new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }),
  )
  expect(ajv.validateSchema(schema), ajv.errorsText(ajv.errors)).toBe(true)
  ajv.addSchema(schema)
  return (definition) => {
    const validate = ajv.getSchema(`${schemaId}#/$defs/${definition}`)
    if (!validate) throw new Error(`validator not found: ${definition}`)
    return validate
  }
}

const senderValidator = validatorsFor(senderSchema)
const receiverValidator = validatorsFor(receiverSchema)

function definitionName(ref: { $ref: string }): string {
  return ref.$ref.replace('#/$defs/', '')
}

const serverToClientDefinitions = new Set<string>([
  'JsonRpcErrorResponse',
  'ReadyLineOk',
  'ReadyLineError',
])
for (const method of Object.values(senderSchema['x-methods']) as SchemaObject[]) {
  if (method.direction === 'server-to-client' && method.kind === 'notification') {
    serverToClientDefinitions.add(definitionName(method.params))
  }
  if (method.direction === 'client-to-server' && method.kind === 'request') {
    serverToClientDefinitions.add(definitionName(method.result))
  }
}

function exampleFor(node: JsonSchema, seen: Set<string> = new Set()): unknown {
  if (typeof node === 'boolean') return null
  const schema = node as SchemaObject
  if (schema.$ref) {
    const name = definitionName(schema as { $ref: string })
    if (seen.has(name)) throw new Error(`recursive fixture is unsupported: ${name}`)
    return exampleFor(senderSchema.$defs[name], new Set([...seen, name]))
  }
  if ('const' in schema) return schema.const
  if (Array.isArray(schema.enum)) return schema.enum[0]

  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (types.includes('null')) return null
  if (types.includes('object') || schema.properties) {
    return Object.fromEntries(
      (schema.required ?? []).map((name: string) => [
        name,
        exampleFor(schema.properties[name], seen),
      ]),
    )
  }
  if (types.includes('array')) return []
  if (types.includes('boolean')) return false
  if (types.includes('integer')) return schema.minimum ?? 0
  if (types.includes('number'))
    return schema.exclusiveMinimum ? schema.exclusiveMinimum + 1 : (schema.minimum ?? 0)
  if (types.includes('string')) {
    if (schema.pattern === '^/') return '/x'
    if (schema.pattern === '^[A-Za-z][A-Za-z0-9+.-]*:') return 'file:///x'
    if (schema.pattern === '^[0-9]+\\.[0-9]+$') return '1.0'
    return 'x'.repeat(Math.max(schema.minLength ?? 1, 1))
  }
  if (Array.isArray(schema.oneOf)) return exampleFor(schema.oneOf[0], seen)
  if (Array.isArray(schema.anyOf)) return exampleFor(schema.anyOf[0], seen)
  return null
}

interface EnumLocation {
  path: string
  sender: SchemaObject
  receiver: SchemaObject
}

function receivedEnums(): EnumLocation[] {
  const found: EnumLocation[] = []
  const visitedDefinitions = new Set<string>()

  const visit = (sender: SchemaObject, receiver: SchemaObject, path: string): void => {
    if (sender.$ref) {
      const name = definitionName(sender as { $ref: string })
      if (visitedDefinitions.has(name)) return
      visitedDefinitions.add(name)
      visit(senderSchema.$defs[name], receiverSchema.$defs[name], `#/$defs/${name}`)
      return
    }
    if (Array.isArray(sender.enum)) found.push({ path, sender, receiver })
    for (const [key, child] of Object.entries(sender)) {
      if (child === null || typeof child !== 'object') continue
      const receiverChild = receiver[key]
      if (Array.isArray(child)) {
        child.forEach((item, index) => {
          if (item && typeof item === 'object')
            visit(item, receiverChild[index], `${path}/${key}/${index}`)
        })
      } else {
        visit(child, receiverChild, `${path}/${key}`)
      }
    }
  }

  for (const name of serverToClientDefinitions) {
    visit(senderSchema.$defs[name], receiverSchema.$defs[name], `#/$defs/${name}`)
  }
  return found
}

describe('session protocol compatibility rule C', () => {
  it('keeps the canonical sender schema strict and does not mutate it', () => {
    expect(senderSchema.$defs.LogKind.enum).toBeDefined()
    expect(receiverSchema.$defs.LogKind.enum).toBeUndefined()
    expect(senderSchema.$defs.LogLineParams.additionalProperties).toBe(false)
    expect(receiverSchema.$defs.LogLineParams.additionalProperties).toBeUndefined()
  })

  it('accepts an unknown key in every S→C root only with the receiver schema', () => {
    for (const definition of serverToClientDefinitions) {
      const example = exampleFor(senderSchema.$defs[definition])
      expect(example, definition).toBeTypeOf('object')
      const withFutureKey = { ...(example as object), futureMinorField: true }
      expect(senderValidator(definition)(withFutureKey), definition).toBe(false)
      expect(receiverValidator(definition)(withFutureKey), definition).toBe(true)
    }
  })

  it('marks every enum received from S→C open or records why it is closed', () => {
    const closed = senderSchema['x-closed-enums'] as Record<string, string>
    const unclassified = receivedEnums()
      .filter(({ path, sender }) => sender['x-open-enum'] !== true && !closed[path]?.trim())
      .map(({ path }) => path)
    expect(unclassified).toEqual([])
  })

  it('widens exactly the enums marked x-open-enum for receivers', () => {
    const enums = receivedEnums()
    expect(enums.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        '#/$defs/ErrorName',
        '#/$defs/EvaluateDiagnostic/properties/kind',
        '#/$defs/DiagnosticTag',
        '#/$defs/Diagnostic/properties/severity',
        '#/$defs/StartupErrorCode',
        '#/$defs/LogLevel',
        '#/$defs/LogKind',
      ]),
    )
    for (const { path, sender, receiver } of enums) {
      const unknown = '__future_minor_value__'
      const senderEnum = senderValidatorForFragment(sender)
      const receiverEnum = senderValidatorForFragment(receiver)
      expect(senderEnum(unknown), path).toBe(false)
      expect(receiverEnum(unknown), path).toBe(sender['x-open-enum'] === true)
    }
  })
})

function senderValidatorForFragment(fragment: SchemaObject): ValidateFunction {
  const ajv = registerProtocolSchemaKeywords(
    new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }),
  )
  return ajv.compile(fragment)
}
