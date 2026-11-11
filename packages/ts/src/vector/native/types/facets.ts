import type { NativeStoredValues } from './stored-values'

/**
 * The native operations that count field values and combine facet counts.
 *
 * @internal
 */
export interface NativeFacetCore {
  /**
   * Counts matched documents once per range using stored numbers and direct numeric array elements.
   *
   * @param values - The field's stored values, indexed by document ordinal.
   * @param matched - The matched ordinals, in at least one bitmap word.
   * @param ranges - The inclusive lower and exclusive upper bounds in successive pairs.
   * @param outCounts - Receives one count per range, with zero for any NaN bound.
   * @returns 0 on success, or a negative status that leaves the output region unchanged.
   */
  storedRangeFacet(
    values: NativeStoredValues,
    matched: Uint32Array,
    ranges: Float64Array,
    outCounts: Uint32Array,
  ): number
  /**
   * Counts stored scalar values and array elements from matched documents.
   *
   * @param values - The field's stored values, indexed by document ordinal.
   * @param matched - The matched ordinals, in at least one bitmap word.
   * @param outValues - Receives the first matched element position for each distinct value.
   * @param outCounts - Receives each value's occurrence count, excluding null and encoded objects.
   * @returns The bucket count, or a negative status that leaves the output regions unchanged.
   */
  valueFacet(values: NativeStoredValues, matched: Uint32Array, outValues: Uint32Array, outCounts: Uint32Array): number
  /**
   * Counts matched documents for each enum value's posting list.
   *
   * @param offsets - The posting start of each value, followed by the terminal offset.
   * @param postings - The document ordinals in all posting lists.
   * @param matched - The matched ordinals, in at least one bitmap word.
   * @param outCounts - Receives one matched document count per value, including zero for an empty list.
   * @returns 0 on success, or a negative status that leaves the output region unchanged.
   */
  enumFacet(offsets: Uint32Array, postings: Uint32Array, matched: Uint32Array, outCounts: Uint32Array): number
  /**
   * Counts matched documents for each distinct numeric value in ascending order.
   *
   * @param values - The field entries in ascending numeric order.
   * @param ordinals - The document ordinal of each entry, with the same length as values.
   * @param matched - The matched ordinals, in at least one bitmap word.
   * @param outValues - Receives the distinct values, with signed zeros combined.
   * @param outCounts - Receives each value's matched document count.
   * @returns The bucket count, or a negative status that leaves the output regions unchanged.
   */
  numberFacet(
    values: Float64Array,
    ordinals: Uint32Array,
    matched: Uint32Array,
    outValues: Float64Array,
    outCounts: Uint32Array,
  ): number
  /**
   * Counts matched documents once in each numeric range that contains one of their values.
   *
   * @param values - The field entries in ascending numeric order.
   * @param ordinals - The document ordinal of each entry, with the same length as values.
   * @param matched - The matched ordinals, in at least one bitmap word.
   * @param ranges - The inclusive lower and exclusive upper bounds of each range in successive pairs.
   * @param outCounts - Receives one count per range, including zero for any range with a NaN bound.
   * @returns 0 on success, or a negative status that leaves the output region unchanged.
   */
  rangeFacet(
    values: Float64Array,
    ordinals: Uint32Array,
    matched: Uint32Array,
    ranges: Float64Array,
    outCounts: Uint32Array,
  ): number
  /**
   * Counts matched documents for each boolean value.
   *
   * @param trueBits - The ordinals that hold true, in at least one bitmap word.
   * @param falseBits - The ordinals that hold false, in at least one bitmap word.
   * @param matched - The matched ordinals, in at least one bitmap word.
   * @param counts - Receives the true count and false count in its first two entries.
   * @returns 0 on success, or a negative status with the output unchanged.
   */
  booleanFacet(trueBits: Uint32Array, falseBits: Uint32Array, matched: Uint32Array, counts: Uint32Array): number
  /**
   * Combines facet counts and returns the selected buckets with their error bound.
   *
   * @param offsets - Each source list's start in the flattened arrays, followed by the total entry count.
   * @param values - The value key of each bucket, which indexes valueRanks.
   * @param counts - The count of each bucket in source-list order.
   * @param bounds - Each source list's largest omitted count.
   * @param valueRanks - The code point order of the bucket keys, indexed by value key.
   * @param ascending - Whether counts order lowest first, with bucket keys deciding ties.
   * @param limit - The number of buckets to keep, or null to keep every bucket.
   * @param outValues - Receives the selected value keys.
   * @param outCounts - Receives each selected value's combined count.
   * @param outBound - Receives the error bound in its first word, including for an empty merge.
   * @returns The bucket count, or a negative core status that leaves inputs and output regions unchanged.
   */
  mergeFacets(
    offsets: Uint32Array,
    values: Uint32Array,
    counts: Uint32Array,
    bounds: Uint32Array,
    valueRanks: Uint32Array,
    ascending: boolean,
    limit: number | null,
    outValues: Uint32Array,
    outCounts: Uint32Array,
    outBound: Uint32Array,
  ): number
}
