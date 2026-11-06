/**
 * The keyword scoring operation of the native search core, which scores the documents of one segment by BM25
 * from posting lists that the engine describes as offsets into the segment's posting arrays.
 *
 * @internal
 */
export interface NativeKeywordCore {
  /**
   * Scores the documents of one segment for a keyword query and writes the best of them, best first, into
   * buffers that the caller owns.
   *
   * @param poolDocIds - The document ordinals of every posting that the segment holds.
   * @param poolFrequencies - The term frequency of each of those postings.
   * @param poolFields - The field index of each of those postings.
   * @param rowDocIds - The document ordinals of the rows that the engine copied for this query.
   * @param rowFrequencies - The frequency of each copied row, which can pass 65,535 for a synonym row.
   * @param rowFields - The field index of each copied row.
   * @param slots - Four numbers per slot: its kind, its query term, the end of its lists, and the end of its values.
   * @param lists - Three numbers per list: its flags, its first posting, and its posting count.
   * @param listValues - Two numbers per list: its document frequency, or its factor and its partial factor.
   * @param slotValues - The document frequency of each group, and the document frequencies of each phrase.
   * @param searchable - 1 for each field that the query searches, and 0 for each other field.
   * @param partialMarks - 1 for each field that partial-word search covers, and 0 for each other field.
   * @param nameRanks - The position of each field's name in code point order.
   * @param fieldNumbers - Four columns of one number per field: the boost, the average length, `k1`, and `b`.
   * @param lengths - The length column of each field, or null for a field that records no lengths.
   * @param filter - The ordinals that the query's filters keep, or null for every ordinal.
   * @param live - The ordinals of the segment's live documents.
   * @param removed - The ordinals whose rows the segment retired or tombstoned.
   * @param settings - The slot count, term count, capacity, document count, term match, anchor, limit, minimum score, and collect flag.
   * @param ordinals - Receives the ordinals of the documents that the call returns, one place per ordinal of the capacity.
   * @param scores - Receives the score of each returned ordinal.
   * @param matched - Receives every kept ordinal where the settings ask for them.
   * @param outcome - Receives the count of returned ordinals and the count of kept ordinals, followed, when it has a
   * third place, by how the core scored the segment: 0 in full, 1 by pruning, and 2 in full after a pruning check failed.
   * @returns 0 when the call scored the segment, or the core's status code when it refused the request.
   */
  keywordScore(
    poolDocIds: Uint32Array,
    poolFrequencies: Uint16Array,
    poolFields: Uint16Array,
    rowDocIds: Uint32Array,
    rowFrequencies: Float64Array,
    rowFields: Uint16Array,
    slots: Uint32Array,
    lists: Uint32Array,
    listValues: Float64Array,
    slotValues: Float64Array,
    searchable: Uint8Array,
    partialMarks: Uint8Array,
    nameRanks: Uint16Array,
    fieldNumbers: Float64Array,
    lengths: ReadonlyArray<Uint32Array | null>,
    filter: Uint32Array | null,
    live: Uint32Array,
    removed: Uint32Array,
    settings: Float64Array,
    ordinals: Int32Array,
    scores: Float64Array,
    matched: Uint32Array,
    outcome: Float64Array,
  ): number
}
