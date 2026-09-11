/**
 * Method evaluation for Interpreter V2
 * Handles method calls and argument processing
 */

import { isOutputDest } from '../core/sequence/audio-line'

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
export async function callMethod(obj: any, methodName: string, args: any[]): Promise<any> {
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
/**
 * #611 §3.8: methods that fold one or more `name:` arguments into a single trailing options
 * object instead of the staged-error path below. `output`/`send` are the only ones today
 * (`{ thru, db }` / `{ db, enabled }`) — every other DSL method's named args stay staged.
 */
const NAMED_ARG_SCHEMA: Readonly<Record<string, Readonly<Record<string, 'boolean' | 'number'>>>> = {
  output: { thru: 'boolean', db: 'number' },
  send: { db: 'number', enabled: 'boolean' },
}

export async function processArguments(methodName: string, args: any[]): Promise<any[]> {
  const processed: any[] = []
  const schema = NAMED_ARG_SCHEMA[methodName]
  const options: Record<string, unknown> = {}
  let sawNamedArg = false

  for (const arg of args) {
    if (arg && typeof arg === 'object' && arg.type === 'named_arg') {
      // #611 §2.1/§2.3: `amount:` was the pre-#611 send() unit (linear 0.0-1.0); it was
      // renamed to `db:` and its unit changed to decibels. A script still writing `amount:`
      // must fail loudly instead of having that value silently misread as dB.
      if (methodName === 'send' && arg.name === 'amount') {
        throw new Error(
          `send() no longer accepts amount: — it was renamed to db: and its unit changed ` +
            `from linear (0.0-1.0) to decibels (#611).`,
        )
      }
      if (schema && arg.name in schema) {
        const expectedType = schema[arg.name]
        if (typeof arg.value !== expectedType) {
          throw new Error(
            `${methodName}() named argument "${arg.name}:" must be a ${expectedType}, got ` +
              `${typeof arg.value}.`,
          )
        }
        if (arg.name in options) {
          throw new Error(`${methodName}() specifies duplicate "${arg.name}:".`)
        }
        options[arg.name] = arg.value
        sawNamedArg = true
        continue
      }
      // Plugin-name dispatch handles selectors before reaching this function.
      // Any named argument that arrives here belongs to a DSL method and must
      // receive an explicit staged error (SC.3.3).
      let stage: string
      switch (arg.name) {
        case 'format':
        case 'vendor':
          stage =
            `string-form ${methodName}() does not accept selectors; ` +
            `use the plugin-name method form Name(format: "vst3")`
          break
        case 'sidechain':
          stage = 'sidechain routing arrives in #409'
          break
        case 'outs':
          stage = 'multi-output routing arrives in #409'
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

  if (sawNamedArg) {
    processed.push(options)
    // output/send receive `(destination, options)`. With named arguments only, the parser's
    // options bag would otherwise occupy the destination slot. Use the same `kind`-field
    // discriminator as the runtime call sites so the two layers cannot disagree.
    if (
      (methodName === 'output' || methodName === 'send') &&
      processed.length === 1 &&
      !isOutputDest(processed[0])
    ) {
      processed.unshift(undefined)
    }
  }
  return processed
}
