import type { NativeFrozenStrings } from './frozen-segments'
import type { NativeGrowingSegment } from './segments'

/** The keyword regions and selected ordinals of one merge source. @internal */
export interface NativeKeywordMergeInput {
  /** The growing keyword regions, when the source uses mutable slices. Frozen posting columns are ignored. */
  growing?: NativeGrowingSegment | null
  /** The UTF-8 terms and their stored document counts. */
  terms: NativeFrozenStrings
  /** The posting slot of each term. */
  payloadSlots: Uint32Array
  /** The first posting of each slot, followed by the terminal posting count. */
  postingOffsets: Uint32Array
  /** The source document ordinal of each posting. */
  postingDocuments: Uint32Array
  /** The capped frequency of each posting. */
  postingFrequencies: Uint16Array
  /** The source field ordinal of each posting. */
  postingFields: Uint16Array
  /** The first position of each posting and the terminal count, or null without positions. */
  positionOffsets: Uint32Array | null
  /** The position values, or null without positions. */
  positionValues: Uint32Array | null
  /** The target ordinal of each source document, or UINT32_MAX for a dropped document. */
  mapping: Uint32Array
  /** The target field ordinal of each source field. */
  fieldMapping: Uint16Array
  /** The source field length columns, with null for a field without lengths. */
  fieldLengths: readonly (Uint32Array | null)[]
  /** The number of source document ordinals. */
  documentCount: number
  /** The surface and token pairs, with counts already restricted to the selected documents. */
  surfaces: NativeFrozenStrings | null
  /** The spelling and token pairs, with counts already restricted to the selected documents. */
  spellings: NativeFrozenStrings | null
}

/** The caller-owned columns that receive one merged keyword segment. @internal */
export interface NativeKeywordMergeOutput {
  /** The terms in code point order, with their live document counts. */
  terms: NativeFrozenStrings
  /** The first posting of each term and the terminal posting count. */
  postingOffsets: Uint32Array
  /** The target document ordinal of each posting, ascending within each term. */
  postingDocuments: Uint32Array
  /** The unchanged capped posting frequencies. */
  postingFrequencies: Uint16Array
  /** The target field ordinals, preserving the source order within each document. */
  postingFields: Uint16Array
  /** The position boundaries, or null when every source omits positions. */
  positionOffsets: Uint32Array | null
  /** The unchanged posting positions, or null when every source omits positions. */
  positionValues: Uint32Array | null
  /** The merged field length columns in field-major order. */
  fieldLengths: Uint32Array
  /** The length total of each target field. */
  totalFieldLengths: Float64Array
  /** The merged surface and token pairs in surface order. */
  surfaces: NativeFrozenStrings
  /** The merged spelling and token pairs in spelling and token order. */
  spellings: NativeFrozenStrings
}

/** The columns that receive a merged paged posting list. @internal */
export interface NativePostingMergeOutput {
  /** The target document ordinals in ascending order. */
  documents: Uint32Array
  /** The unchanged frequencies, with the same capacity as documents. */
  frequencies: Uint16Array
  /** The mapped fields in ascending order within each document, with the same capacity as documents. */
  fields: Uint16Array
  /** The first position of each output row, followed by the terminal position count. */
  positionOffsets: Uint32Array
  /** The unchanged positions of the retained rows. */
  positions: Uint32Array
  /** Receives the distinct document count and the total frequency in its first two entries. */
  totals: Float64Array
}

/** The operations that measure and write immutable keyword merges. @internal */
export interface NativeSegmentMergeCore {
  /**
   * Remaps and orders the selected posting rows by target document and field for paged storage.
   * @param inputs - Frozen source rows for one term, with document and field mappings.
   * @param documentCount - The target document count.
   * @param fieldCount - The target field count, at most 65,536.
   * @param output - The writable columns. Position offsets need one more entry than the retained row count.
   * @returns The retained row count, or a negative status that leaves every output unchanged.
   */
  mergePostings(
    inputs: readonly NativeKeywordMergeInput[],
    documentCount: number,
    fieldCount: number,
    output: NativePostingMergeOutput,
  ): number
  /**
   * Measures the regions needed by a keyword merge without changing its sources.
   * @param inputs - The source columns, document mappings, and prepared surface and spelling counts.
   * @param documentCount - The target document count. Kept mappings must cover each target ordinal exactly once.
   * @param fieldCount - The target field count, at most 65,536.
   * @param sizes - Receives nine uint32 values: term count, term bytes, posting count, position count,
   * position presence, surface count, surface bytes, spelling count, and spelling bytes.
   * @param retainedTerms - The completed paged term table, when merging metadata after streaming postings.
   * Sources must then have empty term and posting regions. The output includes this table and no postings.
   * @returns Zero on success, eight when a surface or spelling count requires split outputs,
   * or another positive core status. Every refusal leaves all regions unchanged.
   */
  measureMerge(
    inputs: readonly NativeKeywordMergeInput[],
    documentCount: number,
    fieldCount: number,
    sizes: Uint32Array,
    retainedTerms?: NativeFrozenStrings | null,
  ): number
  /**
   * Writes a merged keyword segment into the supplied regions.
   * @param inputs - The unchanged sources and mappings used for measurement.
   * @param documentCount - The target document count.
   * @param fieldCount - The target field count.
   * @param output - The writable regions, with capacities obtained from measureMerge.
   * @param retainedTerms - The completed paged term table supplied to measureMerge, or null for a full merge.
   * @returns Zero on success, three for a short region, eight when a count requires split outputs,
   * or another positive core status. Every refusal leaves all regions unchanged.
   */
  writeMerge(
    inputs: readonly NativeKeywordMergeInput[],
    documentCount: number,
    fieldCount: number,
    output: NativeKeywordMergeOutput,
    retainedTerms?: NativeFrozenStrings | null,
  ): number
}
