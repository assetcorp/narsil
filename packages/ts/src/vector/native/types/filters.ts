/**
 * A typed field region that a filter plan reads.
 *
 * @internal
 */
export type NativeFilterRegion = Uint16Array | Uint32Array | Float64Array | BigUint64Array

/**
 * The native operation that evaluates field tests and boolean expressions.
 *
 * @internal
 */
export interface NativeFilterCore {
  /**
   * Writes the live document ordinals that pass a postfix filter plan.
   *
   * @param plan - Groups of four words containing opcode, field, operator, and operand.
   * @param numbers - Numeric operands, with each numeric list preceded by its item count.
   * @param units - The UTF-16 code units of string operands.
   * @param offsets - Each string's start, followed by the terminal code-unit offset.
   * @param lists - Pairs containing the first string and item count of each string list.
   * @param bitsets - Operand bitmaps for pattern tests, text ranges, and complete sets.
   * @param kinds - Each field's kind: 0 absent, 1 numeric, 2 boolean, 3 enum, or 4 geo.
   * @param fields - Each field's present bitmap followed by its regions. Numeric fields take values and ordinals; boolean fields take true and false bitmaps; enum fields take units, offsets, posting offsets, postings, and suffix order; geo fields take codes, latitudes, longitudes, and ordinals.
   * @param live - The live ordinals, in at least one bitmap word.
   * @param into - Receives one word per live bitmap word, without overlapping an input region.
   * @returns 0 on success, or a negative status that leaves the output unchanged.
   */
  evaluateFilter(
    plan: Uint32Array,
    numbers: Float64Array,
    units: Uint16Array,
    offsets: Uint32Array,
    lists: Uint32Array,
    bitsets: readonly Uint32Array[],
    kinds: Uint8Array,
    fields: readonly (readonly NativeFilterRegion[])[],
    live: Uint32Array,
    into: Uint32Array,
  ): number
}
