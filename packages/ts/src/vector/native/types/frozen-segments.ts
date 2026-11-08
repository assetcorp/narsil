import type { NativeFieldTokens } from './segments'

/** The UTF-8 strings and stored counts of an immutable keyword table. @internal */
export interface NativeFrozenStrings {
  /** The concatenated UTF-8 text. */
  text: Uint8Array
  /** The text boundaries, with two strings per surface entry and one per other entry. */
  offsets: Uint32Array
  /** The stored count of each entry. */
  counts: Uint32Array
}

/** The optional reverse posting index for removing a frozen document. @internal */
export interface NativeFrozenRemovalIndex {
  /** Each document's first row reference, followed by the terminal reference count. */
  starts: Uint32Array
  /** The posting row references, in ascending order within each document. */
  rows: Uint32Array
  /** The sorted term ordinal for each payload slot. */
  termOfSlot: Uint32Array
}

/** The immutable keyword regions of a frozen segment. @internal */
export interface NativeFrozenSegment {
  /** The terms in code point order, with their stored document frequencies. */
  terms: NativeFrozenStrings
  /** The posting slot for each sorted term ordinal. */
  payloadSlots: Uint32Array
  /** Each payload slot's first posting, followed by the terminal posting count. */
  postingOffsets: Uint32Array
  /** The document ordinal of each posting. */
  postingDocuments: Uint32Array
  /** The capped term frequency of each posting. */
  postingFrequencies: Uint16Array
  /** The field ordinal of each posting. */
  postingFields: Uint16Array
  /** The surface and token pairs, or null when surfaces are absent. */
  surfaces: NativeFrozenStrings | null
  /** The spellings in spelling and token order, or null when partial words are absent. */
  spellings: NativeFrozenStrings | null
  /** The sorted term ordinal of each spelling, or an empty region when spellings are absent. */
  spellingTokens: Uint32Array
  /** The reverse posting index, or null to scan the posting lists. */
  removalIndex: NativeFrozenRemovalIndex | null
  /** One for each partial-word field and zero for every other field. */
  partialFields: Uint8Array
  /** The number of document ordinals in this segment. */
  documentCount: number
  /** The selected document's sorted term and frequency pairs, when its postings remain on disk. */
  removalTerms?: Uint32Array | null
}

/** The removal regions that one copy holds separately from a shared frozen segment. @internal */
export interface NativeFrozenSegmentState {
  /** The removed document ordinals in the uint32 bitset layout. */
  tombstones: Uint32Array
  /** The single-word count of removed documents. */
  tombstoneCount: Uint32Array
  /** The removed document count for each sorted term. */
  removedDocuments: Uint32Array
  /** The removed capped term frequencies for each sorted term. */
  removedOccurrences: Float64Array
  /** The removed occurrences of each surface entry. */
  removedSurfaces: Uint32Array
  /** The removed occurrences of each spelling entry. */
  removedSpellings: Uint32Array
}

/** The operations that remove documents from immutable keyword segments. @internal */
export interface NativeFrozenSegmentCore {
  /**
   * Prepares a frozen removal for publication after the host finishes the document's other changes.
   * @param segment - The immutable keyword regions and optional reverse posting index.
   * @param state - The current removal regions, which this call preserves.
   * @param ordinal - The document ordinal, below the segment's document count.
   * @param fields - The document's analysed tokens, grouped by ascending field ordinal.
   * @param entries - Receives pairs of region kind and element index for each changed value.
   * Region kinds are 0 for removed documents, 1 for removed occurrences, 2 for removed surfaces,
   * 3 for removed spellings, 4 for tombstone words, and 5 for the tombstone count.
   * @param values - Receives the replacement values in the same order as the entry pairs.
   * @returns The number of changes, or a negative core status that leaves every region unchanged.
   * The host must keep the publication write gate until it copies every prepared value into its region.
   */
  prepareFrozenRemoval(
    segment: NativeFrozenSegment,
    state: NativeFrozenSegmentState,
    ordinal: number,
    fields: readonly NativeFieldTokens[],
    entries: Uint32Array,
    values: Float64Array,
  ): number
  /**
   * Records one document's removal while preserving the shared segment regions.
   * @param segment - The immutable keyword regions and optional reverse posting index.
   * @param state - The writable removal regions of this copy.
   * @param ordinal - The document ordinal, below the segment's document count.
   * @param fields - The document's analysed tokens, grouped by ascending field ordinal.
   * @returns Zero on success, including an ordinal already removed, or a positive core status on refusal.
   * Every refusal leaves the source and removal regions unchanged.
   */
  removeFrozenDocument(
    segment: NativeFrozenSegment,
    state: NativeFrozenSegmentState,
    ordinal: number,
    fields: readonly NativeFieldTokens[],
  ): number
}
