/**
 * 正本のスキーマ（`protocol/session/v1/session.schema.json`）を実行時に読み、メソッドの一覧・
 * エラーコード・params と結果の検証を作る（設計 848 §5.8: スキーマが単一の真実）。
 *
 * 型は生成物（`@orbitscore/protocol/gen/ts/session/v1/session`）から、実行時の一覧と検証は同じ
 * スキーマの JSON から取るので、メソッドの集合を TS の側に二重に書かない。
 */
import fs from 'node:fs'
import path from 'node:path'

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020'

const SCHEMA_ID = 'urn:orbitscore:protocol:session:v1'

export interface MethodSpec {
  direction: 'client-to-server' | 'server-to-client'
  kind: 'request' | 'notification'
  params?: { $ref: string }
  result?: { $ref: string }
  'x-editor-request'?: 'same' | { params: { $ref: string }; result: { $ref: string } }
  'x-surfaces': string[]
  'x-mcp-tools'?: string[]
}

interface SessionSchema {
  'x-protocol-version': string
  'x-errors': Record<string, number>
  'x-methods': Record<string, MethodSpec>
  [key: string]: unknown
}

function loadSchema(): SessionSchema {
  const pkg = require.resolve('@orbitscore/protocol/package.json')
  const file = path.join(path.dirname(pkg), 'session', 'v1', 'session.schema.json')
  return JSON.parse(fs.readFileSync(file, 'utf8')) as SessionSchema
}

const schema = loadSchema()

/** このビルドが話すプロトコルの版（`x-protocol-version`）。 */
export const PROTOCOL_VERSION: string = schema['x-protocol-version']
export const ERROR_CODES: Readonly<Record<string, number>> = schema['x-errors']
export const METHODS: Readonly<Record<string, MethodSpec>> = schema['x-methods']

export type ErrorName = keyof typeof ERROR_CODES & string

/** JSON-RPC のエラーとして返す失敗。`name` は `x-errors` のキー（`data.code` に入る）。 */
export class RpcError extends Error {
  constructor(
    readonly errorName: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message)
    if (!(errorName in ERROR_CODES)) throw new Error(`unknown protocol error: ${errorName}`)
  }

  get code(): number {
    return ERROR_CODES[this.errorName]!
  }
}

/** `"MAJOR.MINOR"` の MAJOR。読めなければ null。 */
export function majorOf(version: unknown): number | null {
  if (typeof version !== 'string') return null
  const match = /^([0-9]+)\.[0-9]+$/.exec(version)
  return match ? Number(match[1]) : null
}

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true })
for (const keyword of ['x-protocol-version', 'x-surface-vocabulary', 'x-errors', 'x-methods']) {
  ajv.addKeyword(keyword)
}
ajv.addSchema(schema as object, SCHEMA_ID)

const validators = new Map<string, ValidateFunction>()

function validatorFor(ref: string): ValidateFunction {
  let validate = validators.get(ref)
  if (!validate) {
    validate = ajv.compile({ $ref: `${SCHEMA_ID}${ref}` })
    validators.set(ref, validate)
  }
  return validate
}

function describe(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '(root)'} ${error.message ?? 'is invalid'}`)
    .join('; ')
}

/** params を検証する。違えば `INVALID_PARAMS` を投げる（params の値はメッセージに入れない）。 */
export function assertParams(method: string, params: unknown): void {
  const ref = METHODS[method]?.params?.$ref
  if (!ref) return
  const validate = validatorFor(ref)
  if (!validate(params ?? {})) {
    throw new RpcError('INVALID_PARAMS', `invalid params for ${method}`, describe(validate.errors))
  }
}

/** 層 2 が返す結果がスキーマに合うか（実装の誤りを黙って wire に出さない）。合わなければ理由。 */
export function resultProblem(method: string, result: unknown): string | null {
  const ref = METHODS[method]?.result?.$ref
  if (!ref) return null
  const validate = validatorFor(ref)
  return validate(result) ? null : describe(validate.errors)
}

/** 通知の params がスキーマに合うか（ブロードキャストの前に確かめる）。 */
export function notificationProblem(method: string, params: unknown): string | null {
  const ref = METHODS[method]?.params?.$ref
  if (!ref) return `unknown notification ${method}`
  const validate = validatorFor(ref)
  return validate(params) ? null : describe(validate.errors)
}
