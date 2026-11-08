import type { NativeTermTable } from './terms'

/** The allocator regions for posting slices and run membership lists. @internal */
export interface NativeSliceAllocator {
  /** The used end and the number of free entries. */
  allocation: Uint32Array
  /** The first free slice for each class, or UINT32_MAX. */
  freeHeads: Uint32Array
  /** The strictly increasing capacity of each slice class. */
  sliceCapacities: Uint32Array
}

/** The posting metadata indexed by term ordinal. @internal */
export interface NativeTermColumns {
  /** The first posting of each term's slice. */
  sliceStart: Uint32Array
  /** The allocated slice class of each term. */
  sliceClass: Uint8Array
  /** The number of occupied entries in each slice. */
  lengths: Uint32Array
  /** The stored document count of each term. */
  docFrequency: Uint32Array
  /** The removed document count of each term. */
  deadDocuments: Uint32Array
  /** The sum of the live, capped posting frequencies. */
  totalTermFrequency: Float64Array
  /** The sum of the live surface counts for each term. */
  surfaceOccurrences: Float64Array
  /** The revision that invalidates each term's cached posting view. */
  revision: Uint32Array
  /** The live, ordered, and position flags, in bits zero, one, and two. */
  flags: Uint8Array
}

/** The shared posting columns and their slice allocator. @internal */
export interface NativePostingPool extends NativeSliceAllocator {
  /** The document ordinal at each posting. */
  docIds: Uint32Array
  /** The capped frequency at each posting. */
  frequencies: Uint16Array
  /** The field ordinal at each posting. */
  fieldIndices: Uint16Array
  /** The first position entry for each posting, or null when positions are absent. */
  positionStarts: Uint32Array | null
}

/** The position lists and their allocation metadata. @internal */
export interface NativePositionPool {
  /** Each list's length followed by its positions, with word zero reserved for an empty list. */
  values: Uint32Array
  /** The used end and the number of free words. */
  allocation: Uint32Array
}

/** The surface strings and their live counts. @internal */
export interface NativeSurfaceTable {
  /** The surface dictionary. */
  strings: NativeTermTable
  /** The term ordinal associated with each surface. */
  token: Uint32Array
  /** The occurrence count of each surface within this segment. */
  count: Uint32Array
}

/** The three-code-point runs and their spelling membership lists. @internal */
export interface NativeRunTable extends NativeSliceAllocator {
  /** The eight-word header, with the run count at zero and slot capacity at two. */
  header: Uint32Array
  /** The run ordinal plus one, zero for an empty slot, or minus one for a removed slot. */
  slots: Int32Array
  /** Three consecutive code points for each run. */
  runs: Uint32Array
  /** The start of each run's member slice. */
  listStart: Uint32Array
  /** The number of members in each run. */
  listLength: Uint32Array
  /** The allocated slice class of each run. */
  listClass: Uint8Array
  /** The spelling ordinals, in ascending order within each run. */
  members: Uint32Array
}

/** The written spellings used for partial-word search. @internal */
export interface NativeSpellingTable extends NativeSurfaceTable {
  /** The length in code points of each spelling. */
  codePoints: Uint32Array
  /** The runs that locate spellings containing a query fragment. */
  runs: NativeRunTable
}

/** The mutable keyword regions of one segment, protected by its copy's publication gate. @internal */
export interface NativeGrowingSegment {
  /** The term dictionary. */
  terms: NativeTermTable
  /** The term posting metadata. */
  columns: NativeTermColumns
  /** The posting columns and their allocator. */
  postings: NativePostingPool
  /** The position lists, or null when the segment does not track positions. */
  positions: NativePositionPool | null
  /** The surface table, or null when no token has a separate surface. */
  surfaces: NativeSurfaceTable | null
  /** The spelling table, or null when the segment has no partial-word field. */
  spellings: NativeSpellingTable | null
  /** The retired document ordinals as a uint32 bitset. */
  retired: Uint32Array
  /** The field lengths in field-major order, with ordinalCapacity words per field. */
  fieldLengths: Uint32Array
  /** The single-word live document count. */
  totalDocuments: Uint32Array
  /** The live field length totals, indexed by field. */
  totalFieldLengths: Float64Array
  /** One for a partial-word field, or zero, with one byte per field. */
  partialFields: Uint8Array
  /** The document ordinal capacity of the segment. */
  ordinalCapacity: number
}

/** The prepared tokens of one text field, including an empty token region. @internal */
export interface NativeFieldTokens {
  /** The field ordinal, in ascending order across the request. */
  field: number
  /** The eight-word token records returned by native analysis. */
  tokens: Uint32Array
  /** The UTF-16 text referenced by the token records. */
  units: Uint16Array
}

/** The operations that publish complete documents into keyword segments. @internal */
export interface NativeSegmentCore {
  /**
   * Adds all the indexed text fields and the document count in one publication.
   * @param segment - The writable keyword regions of one growing segment.
   * @param ordinal - The document ordinal, below the segment's capacity.
   * @param fields - The prepared fields, each present at most once in ascending field order.
   * @returns Zero on success, three when a region needs room, eight when a count requires a new segment,
   * or another positive core status on refusal. Every nonzero status leaves all regions unchanged.
   */
  indexTerms(segment: NativeGrowingSegment, ordinal: number, fields: readonly NativeFieldTokens[]): number
  /**
   * Removes one document's keyword counts, surfaces, spellings, and field lengths.
   * @param segment - The writable keyword regions of one growing segment.
   * @param ordinal - The document ordinal, below the segment's capacity.
   * @param fields - The document's analysed tokens, grouped by ascending field ordinal.
   * @returns Zero on success, including an ordinal already retired, or a positive core status on refusal.
   * Every refusal leaves all regions unchanged.
   */
  removeDocument(segment: NativeGrowingSegment, ordinal: number, fields: readonly NativeFieldTokens[]): number
  /**
   * Compacts retired posting rows before a batch of writes.
   * @param segment - The writable keyword regions of one growing segment.
   * @returns Zero on success, or a positive core status with every region unchanged on refusal.
   */
  beginBatch(segment: NativeGrowingSegment): number
  /**
   * Compacts retired posting rows after a batch while preserving live counts and retired ordinals.
   * @param segment - The writable keyword regions of one growing segment.
   * @returns Zero on success, or a positive core status with every region unchanged on refusal.
   */
  endBatch(segment: NativeGrowingSegment): number
}
