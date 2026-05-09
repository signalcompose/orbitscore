/**
 * Per-sequence quantize override.
 *
 * When unset, the sequence inherits the global quantize value. When set
 * explicitly via `seq.quantize("...")`, the sequence ignores the global value.
 */

import { QuantizeValue, isQuantizeValue } from '../../global/quantize-manager'

export class SequenceQuantizeManager {
  private _value?: QuantizeValue

  setQuantize(value: QuantizeValue): void {
    if (!isQuantizeValue(value)) {
      throw new Error(
        `seq.quantize() expects one of "off" | "beat" | "bar" | "2bar" | "4bar" | "8bar", got: ${String(value)}`,
      )
    }
    this._value = value
  }

  /** Returns the explicit override, or undefined if the sequence inherits the global value. */
  getQuantize(): QuantizeValue | undefined {
    return this._value
  }
}
