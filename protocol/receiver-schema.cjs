/**
 * Build the schema used only when consuming values sent by the peer.
 *
 * The canonical schema remains the strict sender contract. The receiver copy
 * ignores fields added by a newer MINOR and accepts unknown values only for
 * enums explicitly marked with `x-open-enum`. It never mutates input data (in
 * particular, consumers must not use Ajv's `removeAdditional`).
 */
function createReceiverSchema(senderSchema) {
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit)
    if (value === null || typeof value !== 'object') return value

    const receiver = {}
    for (const [key, child] of Object.entries(value)) {
      if (key === 'additionalProperties' && child === false) continue
      if (key === 'enum' && value['x-open-enum'] === true) continue
      receiver[key] = visit(child)
    }
    return receiver
  }

  return visit(senderSchema)
}

/** Register the protocol's annotation keywords before compiling in Ajv strict mode. */
function registerProtocolSchemaKeywords(ajv) {
  const annotations = [
    ['x-open-enum', 'boolean'],
    ['x-since', 'string'],
    ['x-secret', 'boolean'],
    ['x-compatibility', 'object'],
    ['x-closed-enums', 'object'],
    ['x-errors', 'object'],
    ['x-methods', 'object'],
    ['x-protocol-version', 'string'],
    ['x-surface-vocabulary', 'object'],
  ]

  for (const [keyword, schemaType] of annotations) {
    if (ajv.getKeyword?.(keyword) === false) {
      ajv.addKeyword({ keyword, schemaType, valid: true })
    }
  }
  return ajv
}

module.exports = { createReceiverSchema, registerProtocolSchemaKeywords }
