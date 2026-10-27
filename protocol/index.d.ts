export type JsonSchema = boolean | { [keyword: string]: unknown }

export interface AjvKeywordRegistry {
  getKeyword(keyword: string): unknown
  addKeyword(definition: {
    keyword: string
    schemaType: 'boolean' | 'string' | 'object'
    valid: true
  }): unknown
}

/** Make a non-mutating, forward-compatible receiver copy of the strict sender schema. */
export declare function createReceiverSchema<T extends JsonSchema>(senderSchema: T): T

/** Register every OrbitScore annotation keyword for Ajv strict mode. */
export declare function registerProtocolSchemaKeywords<T extends AjvKeywordRegistry>(ajv: T): T
