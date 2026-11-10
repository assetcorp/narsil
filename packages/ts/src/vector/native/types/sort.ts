import type { NativeStoredValues } from './stored-values'

/**
 * The typed regions of reduced sort values, indexed by ordinal or dictionary position.
 *
 * @internal
 */
export interface NativeSortValues {
  /** Marks missing, number, string, false, and true values with tags 0 through 4. */
  kinds: Uint8Array
  /** Holds the finite number at each position whose tag is 1. */
  numbers: Float64Array
  /** Holds the first UTF-16 unit of each string in units. */
  textStart: Uint32Array
  /** Holds each string's UTF-16 length, covering at most 512 code points. */
  textLength: Uint32Array
  /** Holds the UTF-16 units of the strings. */
  units: Uint16Array
}

/**
 * The current values and the last built order of one sort column.
 *
 * @internal
 */
export interface NativeSortColumn {
  /** Holds each ordinal's current reduced value. */
  current: NativeSortValues
  /** Holds the distinct present values of the built order. */
  values: NativeSortValues
  /** Holds each built ordinal's even dictionary rank, or -1 for missing. */
  ranks: Int32Array
  /** Holds the built present ordinals in ascending rank order. */
  ordered: Uint32Array
  /** Marks the ordinals whose current values differ from the built order. */
  dirty: Uint32Array
}

/**
 * Reductions of stored fields for sorting.
 *
 * @internal
 */
export interface NativeSortCore {
  /**
   * Selects ordinals by each field's rank and current value, retaining every cutoff tie.
   *
   * @param columns - The sort columns in field priority order.
   * @param directions - One direction per column, with 0 for ascending and 1 for descending.
   * @param filter - The bitmap of ordinals that pass the filter.
   * @param live - The bitmap of live document ordinals.
   * @param limit - The requested ordinal count before retaining equal sort keys.
   * @param anchorRanks - One rank per anchor field, or null for no anchor.
   * @param anchorValues - One reduced value per anchor field, or null with no anchor ranks.
   * @param output - Receives the selected ordinals, including keys equal to the anchor.
   * @returns The selected count, or a negative status with the output unchanged. The caller orders equal keys by document ID and removes IDs at or before an equal anchor.
   */
  sortSelect(
    columns: readonly NativeSortColumn[],
    directions: Uint8Array,
    filter: Uint32Array,
    live: Uint32Array,
    limit: number,
    anchorRanks: Int32Array | null,
    anchorValues: NativeSortValues | null,
    output: Uint32Array,
  ): number
  /**
   * Selects live values within text bounds in folded and raw sort order.
   *
   * @param column - The current values and built order of the field.
   * @param lower - The lower UTF-16 bound, or null for no lower bound.
   * @param lowerInclusive - Whether a value equal to the lower bound qualifies.
   * @param upper - The upper UTF-16 bound, or null for no upper bound.
   * @param upperInclusive - Whether a value equal to the upper bound qualifies.
   * @param live - The bitmap of live ordinals in the current values.
   * @param output - Receives the matching ordinals, with padding bits cleared.
   * @returns 0 on success, or a negative status with the output unchanged.
   */
  textRange(
    column: NativeSortColumn,
    lower: Uint16Array | null,
    lowerInclusive: boolean,
    upper: Uint16Array | null,
    upperInclusive: boolean,
    live: Uint32Array,
    output: Uint32Array,
  ): number
  /**
   * Builds an ascending dictionary and ranks for the live sort values.
   *
   * @param current - The current values, indexed by document ordinal.
   * @param live - The bitmap of live document ordinals.
   * @param values - Receives the distinct present values in ascending order.
   * @param ranks - Receives each ordinal's even dictionary rank, or -1 for missing and dead ordinals.
   * @param ordered - Receives the live present ordinals in rank order, with equal values in ordinal order.
   * @param dirty - Receives cleared words through the current ordinal capacity.
   * @param counts - Receives the distinct-value count and present-ordinal count in its first two entries.
   * @returns 0 on success, or a negative status with every output region unchanged.
   */
  buildSortOrder(
    current: NativeSortValues,
    live: Uint32Array,
    values: NativeSortValues,
    ranks: Int32Array,
    ordered: Uint32Array,
    dirty: Uint32Array,
    counts: Uint32Array,
  ): number
  /**
   * Reduces a stored field to its sort value under the requested array mode.
   *
   * @param values - The eight typed regions of the stored field.
   * @param ordinal - The document's position in the field regions.
   * @param mode - 0 for min, 1 for max, 2 for avg, or 3 for median. Scalar fields bypass array reduction.
   * @param outNumber - Receives a numeric result in its first entry, with capacity for at least one entry.
   * @param outText - Receives a string's start and UTF-16 length in values.units, with capacity for at least two entries.
   * @returns 0 for missing, 1 for number, 2 for string, 3 for false, or 4 for true. A negative status leaves both output regions unchanged. Missing and boolean results also leave both regions unchanged.
   */
  sortValue(
    values: NativeStoredValues,
    ordinal: number,
    mode: number,
    outNumber: Float64Array,
    outText: Uint32Array,
  ): number
}
