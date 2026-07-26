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
