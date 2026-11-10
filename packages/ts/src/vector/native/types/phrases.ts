/**
 * The postings and stored positions of one phrase token.
 *
 * @internal
 */
export interface NativePhrasePostings {
  /** Each posting's document ordinal. */
  documents: Uint32Array
  /** Each posting's field index. */
  fields: Uint16Array
  /** Each posting's first position in positions. */
  positionStarts: Uint32Array
  /** Each posting's number of positions. */
  positionCounts: Uint32Array
  /** The stored positions, ascending within each posting. */
  positions: Uint32Array
  /** Whether the postings are already in document order. */
  ordered: boolean
}

/**
 * The phrase tokens, searchable fields, and document masks of one segment.
 *
 * @internal
 */
export interface NativePhraseRequest {
  /** The postings of each distinct token, with an empty list for a missing token. */
  postings: readonly NativePhrasePostings[]
  /** Each phrase's start in tokens and offsets, followed by the total entry count. */
  starts: Uint32Array
  /** The posting-list index of each phrase token, in phrase order. */
  tokens: Uint32Array
  /** Each token's position relative to the phrase start. */
  offsets: Uint32Array
  /** One for each searchable field, or zero for an excluded field. */
  searchable: Uint8Array
  /** The permitted document ordinals, or null to search every document. */
  filter: Uint32Array | null
  /** The removed document ordinals. */
  removed: Uint32Array
  /** The logical document capacity of the segment. */
  ordinalCount: number
  /** Whether the operation returns each matching document and field. */
  collect: boolean
}

/**
 * The operation that matches positional phrases and counts their work.
 *
 * @internal
 */
export interface NativePhraseCore {
  /**
   * Finds documents that contain every phrase within a searchable field.
   *
   * @param request - The segment postings, phrases, and document masks.
   * @param meter - The shared int64 work count followed by its cap.
   * @param stop - One uint32 that is zero until the search stops.
   * @param deadline - One uint64 clock deadline, or zero for no deadline.
   * @param matched - Receives the document bitmap, with padding bits cleared.
   * @param starts - Receives one row offset per phrase in request order, followed by the row count.
   * @param documents - Receives each matching row's document ordinal.
   * @param fields - Receives each matching row's field index.
   * @param frequencies - Receives each matching row's number of phrase starts.
   * @returns The row count, or a negative status. Invalid requests and short outputs leave every region unchanged.
   * A work-cap or stop status leaves the output undefined. When collect is true, every row output must hold the sum
   * of the smallest posting count in each phrase, so that capacity refusal happens before the operation counts work.
   */
  matchPhrases(
    request: NativePhraseRequest,
    meter: BigInt64Array,
    stop: Uint32Array,
    deadline: BigUint64Array,
    matched: Uint32Array,
    starts: Uint32Array,
    documents: Uint32Array,
    fields: Uint16Array,
    frequencies: Uint32Array,
  ): number
}
