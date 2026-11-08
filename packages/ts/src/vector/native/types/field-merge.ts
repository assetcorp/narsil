/**
 * A typed region of a field index, stored values, or a pattern index.
 *
 * @internal
 */
export type NativeFieldMergeRegion = Uint8Array | Uint16Array | Uint32Array | Float64Array | BigUint64Array

/**
 * One source field and its document mapping.
 *
 * @internal
 */
export interface NativeFieldMergeSource {
  /** Each source ordinal's target, or 0xFFFFFFFF for a dropped document. */
  mapping: Uint32Array
  /** The field's regions in the order that the merge kind defines. */
  regions: readonly NativeFieldMergeRegion[]
}

/**
 * The operations that combine field regions across segments.
 *
 * @internal
 */
export interface NativeFieldMergeCore {
  /**
   * Measures the regions of one merged field after document remapping.
   *
   * @param kind - 1 numeric, 2 boolean, 3 enum, 4 geo, 5 stored values, or 6 pattern.
   * @param sources - The source fields and disjoint mappings that cover the target ordinals. Numeric regions contain values and ordinals; boolean regions contain true and false bitmaps; enum regions contain units, text offsets, posting offsets, postings, and suffix order; geo regions contain codes, latitudes, longitudes, and ordinals; stored regions contain shapes, starts, kinds, numbers, text starts, text lengths, units, and bytes; pattern regions contain present ordinals, runs, offsets, and postings.
   * @param documentCount - The number of target documents.
   * @param sizes - Receives eight region lengths in elements, with unused entries set to zero.
   * @returns 0 on success, or an existing positive status that leaves all supplied regions unchanged.
   */
  measureFieldMerge(
    kind: number,
    sources: readonly NativeFieldMergeSource[],
    documentCount: number,
    sizes: Uint32Array,
  ): number
  /**
   * Writes the merged field into the measured target regions.
   *
   * @param kind - The field kind used by {@link NativeFieldMergeCore.measureFieldMerge}.
   * @param sources - The source regions and document mappings used for measurement.
   * @param documentCount - The number of target documents.
   * @param output - The target regions in source-region order, each with the measured capacity and no overlap with another target or an input.
   * @returns 0 on success, 3 when a target is too short, or another existing positive status; every refusal leaves all supplied regions unchanged.
   */
  writeFieldMerge(
    kind: number,
    sources: readonly NativeFieldMergeSource[],
    documentCount: number,
    output: readonly NativeFieldMergeRegion[],
  ): number
}
