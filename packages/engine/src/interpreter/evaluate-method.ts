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
  const method = obj[methodName]
  if (!method || typeof method !== 'function') {
    console.error(`Method not found: ${methodName} on ${obj.constructor.name}`)
    return obj
  }

  // Process arguments
  const processedArgs = await processArguments(methodName, args)

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
    if (methodName === 'beat' && arg.numerator !== undefined) {
      // Handle meter: beat(4 by 4) -> beat(4, 4)
      processed.push(arg.numerator, arg.denominator)
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
