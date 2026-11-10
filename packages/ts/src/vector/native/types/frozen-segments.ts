import type { NativePageCache, NativePageSection } from './paged'
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
  /** Eight words, holding the pending document count, the pending token count, and the pending unit count. */
  pendingHeader: Uint32Array
  /** The tombstoned ordinals whose counts the removed regions do not hold yet, in removal order. */
  pendingDocuments: Uint32Array
  /** Five words for each pending token: its field, term offset, term length, surface offset, and surface length. */
  pendingTokens: Uint32Array
  /** The UTF-16 code units that the pending tokens point into. */
  pendingUnits: Uint16Array
}

/** The paged sections that hold the removal entries of a segment whose postings remain on disk. @internal */
export interface NativeFrozenPagedRemovals {
  /** The section that holds the first word of each document's removal entry. */
  offsets: NativePageSection
  /** The section that holds each removal entry's sorted term and frequency pairs. */
  values: NativePageSection
  /** The page cache of the calling thread, or null to read every page from the file. */
  cache: NativePageCache | null
  /** Receives the file identity, section offset, and page number of a page that the core cannot read. */
  fault: BigUint64Array
}

/**
 * The regions of a {@link NativeFrozenSegment} and of its {@link NativeFrozenSegmentState}, as thirty positional
 * arguments in the order that the native binding reads them, so that the binding looks up no property by name.
 * An absent surface table, spelling table, or reverse posting index passes null in each of its positions.
 * @internal
 */
export type NativeFrozenRegionArguments = [
  documentCount: number,
  termText: Uint8Array,
  termOffsets: Uint32Array,
  termCounts: Uint32Array,
  surfaceText: Uint8Array | null,
  surfaceOffsets: Uint32Array | null,
  surfaceCounts: Uint32Array | null,
  spellingText: Uint8Array | null,
  spellingOffsets: Uint32Array | null,
  spellingCounts: Uint32Array | null,
  payloadSlots: Uint32Array,
  postingOffsets: Uint32Array,
  postingDocuments: Uint32Array,
  postingFrequencies: Uint16Array,
  postingFields: Uint16Array,
  partialFields: Uint8Array,
  spellingTokens: Uint32Array,
  removalStarts: Uint32Array | null,
  removalRows: Uint32Array | null,
  removalTermOfSlot: Uint32Array | null,
  tombstones: Uint32Array,
  tombstoneCount: Uint32Array,
  removedDocuments: Uint32Array,
  removedOccurrences: Float64Array,
  removedSurfaces: Uint32Array,
  removedSpellings: Uint32Array,
  pendingHeader: Uint32Array,
  pendingDocuments: Uint32Array,
  pendingTokens: Uint32Array,
  pendingUnits: Uint16Array,
]

/** The operations that remove documents from immutable keyword segments. @internal */
export interface NativeFrozenSegmentCore {
  /**
   * Prepares a frozen removal for publication after the host finishes the document's other changes.
   * @param parameters - The segment's and the state's regions as {@link NativeFrozenRegionArguments}, then the
   * document ordinal below the segment's document count, then the document's analysed tokens whose surface differs
   * from their term or whose field is a partial field, grouped by ascending field ordinal. Then come the entries that
   * receive a region kind and an element index for each changed value, where the kinds are 4 for tombstone words,
   * 5 for the tombstone count, and 6 for pending header words, then the replacement values in the same order, and
   * last the paged removal sections, or null for a segment that holds its postings in memory. The call writes the
   * pending document and tokens past the pending counts, and it settles the pending regions first when they are full.
   * @returns The number of changes, or a negative core status that leaves every region unchanged.
   * The host must keep the publication write gate until it copies every prepared value into its region.
   */
  prepareFrozenRemoval(
    ...parameters: [
      ...NativeFrozenRegionArguments,
      ordinal: number,
      fields: readonly NativeFieldTokens[],
      entries: Uint32Array,
      values: Float64Array,
      paged: NativeFrozenPagedRemovals | null,
    ]
  ): number
  /**
   * Records one document's removal in the pending regions while preserving the shared segment regions.
   * @param parameters - The segment's and the state's regions as {@link NativeFrozenRegionArguments}, then the
   * document ordinal below the segment's document count, then the document's analysed tokens whose surface differs
   * from their term or whose field is a partial field, grouped by ascending field ordinal, and last the paged removal
   * sections, or null for a segment that holds its postings in memory. The core appends every token that it
   * receives to the pending regions.
   * @returns Zero on success, including an ordinal already removed, or a positive core status on refusal.
   * Every refusal leaves the source and removal regions unchanged.
   */
  removeFrozenDocument(
    ...parameters: [
      ...NativeFrozenRegionArguments,
      ordinal: number,
      fields: readonly NativeFieldTokens[],
      paged: NativeFrozenPagedRemovals | null,
    ]
  ): number
  /**
   * Adds every pending removal to the removed regions and empties the pending regions.
   * @param parameters - The segment's and the state's regions as {@link NativeFrozenRegionArguments}, then the paged
   * removal sections, or null for a segment that holds its postings in memory.
   * @returns Zero on success, or a positive core status that leaves every region unchanged.
   */
  settleFrozenState(...parameters: [...NativeFrozenRegionArguments, paged: NativeFrozenPagedRemovals | null]): number
}
