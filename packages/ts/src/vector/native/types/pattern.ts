import type { NativeStoredValues } from './stored-values'

/**
 * The native operations that match stored text and measure search deadlines.
 *
 * @internal
 */
export interface NativePatternCore {
  /**
   * Adds the ordinals whose stored strings match a pattern to a bitmap.
   *
   * @param documents - The field's document ordinals in ascending order.
   * @param runs - Sorted triples of folded code points from the pattern index.
   * @param offsets - Each triple's first posting, followed by the terminal posting offset.
   * @param postings - The ascending document ordinals for each triple.
   * @param values - The stored field regions in the index's ordinal space.
   * @param text - The pattern's UTF-16 code units.
   * @param options - Five words containing the operator, case-fold flag, typo tolerance, preparation-count flag, and matcher byte budget. Operators are 0 equal, 1 prefix, 2 suffix, 3 substring, 4 wildcard, and 5 regular expression. Tolerance is 0, 1, 2, or 3 for automatic selection.
   * @param meter - Two signed 64-bit words containing the atomic work counter and its non-negative cap.
   * @param stop - One atomic word containing 0 to continue or 1 to stop.
   * @param deadline - One unsigned 64-bit monotonic deadline in nanoseconds, or 0 for no deadline.
   * @param into - Receives matching bits, with at least one word and enough words for every stored ordinal. Output and counter regions must not overlap any input or each other.
   * @returns 0 on success, or a negative status. Invalid arguments and allocation refusals leave outputs unchanged; stopping or exceeding the work cap may leave partial output.
   */
  patternTest(
    documents: Uint32Array,
    runs: Uint32Array,
    offsets: Uint32Array,
    postings: Uint32Array,
    values: NativeStoredValues,
    text: Uint16Array,
    options: Uint32Array,
    meter: BigInt64Array,
    stop: Uint32Array,
    deadline: BigUint64Array,
    into: Uint32Array,
  ): number

  /**
   * Writes the current monotonic clock value in nanoseconds.
   *
   * @param into - Receives the clock value in its first word, or the largest unsigned 64-bit value if the clock fails.
   * @returns 0 on success, or a negative status that leaves the output unchanged.
   */
  clockNow(into: BigUint64Array): number
}
