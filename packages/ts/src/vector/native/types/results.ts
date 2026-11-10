/** The native operations that assemble search results. @internal */
export interface NativeResultCore {
  /**
   * Places pins in a ranking and returns the source position of each entry.
   *
   * @param count - The ranked entry count, at most 2^31 - 1.
   * @param ranked - Each pin's ranked position, or -1 for an absent pin, with at most 2^31 - 1 pins.
   * @param positions - The requested position of each pin, in request order.
   * @param depth - Pins at or beyond this depth are skipped, or null to place every pin.
   * @param output - Receives original ranked positions, or -1 minus the pin's index in the supplied pin arrays.
   * @returns The entry count, or a negative core status that leaves inputs and output regions unchanged.
   */
  placePinned(
    count: number,
    ranked: Int32Array,
    positions: Uint32Array,
    depth: number | null,
    output: Int32Array,
  ): number
  /**
   * Merges scored lists by descending score, document ID, and source-list order for ties.
   *
   * @param offsets - The start of each list in the flattened arrays, followed by the total entry count.
   * @param scores - The scores in source-list order, including non-finite scores.
   * @param idRanks - The document ID ranks, comparable across all lists.
   * @param limit - The maximum number of entries to return.
   * @param lists - Receives each entry's source-list position, counting empty lists.
   * @param indices - Receives each entry's position within its source list.
   * @returns The count, or a negative core status that leaves inputs and output regions unchanged.
   */
  mergeRankings(
    offsets: Uint32Array,
    scores: Float64Array,
    idRanks: Uint32Array,
    limit: number,
    lists: Uint32Array,
    indices: Uint32Array,
  ): number
  /**
   * Merges sorted lists by their shared sort ranks, preserving source-list order for ties.
   *
   * @param offsets - The start of each list in the flattened ranks, followed by the total entry count.
   * @param ranks - The ranks by sort values and document ID, comparable across all lists.
   * @param limit - The maximum number of entries to return.
   * @param lists - Receives each entry's source-list position, counting empty lists.
   * @param indices - Receives each entry's position within its source list.
   * @returns The count, or a negative core status that leaves inputs and output regions unchanged.
   */
  mergeSorted(offsets: Uint32Array, ranks: Uint32Array, limit: number, lists: Uint32Array, indices: Uint32Array): number
  /**
   * Combines text and vector rankings and writes them in descending score order, and then document ID order for equal scores.
   *
   * @param strategy - 0 for reciprocal rank fusion, or 1 for a linear combination.
   * @param k - The reciprocal rank constant.
   * @param alpha - The vector weight in a linear combination.
   * @param textKeys - The candidate keys in the text ranking.
   * @param textScores - The score at each position of the text ranking.
   * @param vectorKeys - The candidate keys in the vector ranking.
   * @param vectorScores - The score at each position of the vector ranking.
   * @param idRanks - The code point order of document IDs, indexed by candidate key.
   * @param keys - Receives the fused candidate keys.
   * @param scores - Receives the fused scores.
   * @returns The result count, or a negative core status that leaves the output regions unchanged.
   */
  fuse(
    strategy: number,
    k: number,
    alpha: number,
    textKeys: Uint32Array,
    textScores: Float64Array,
    vectorKeys: Uint32Array,
    vectorScores: Float64Array,
    idRanks: Uint32Array,
    keys: Uint32Array,
    scores: Float64Array,
  ): number
  /**
   * Returns the first result after a cursor anchor.
   *
   * @param count - The logical result count.
   * @param sorted - Whether the anchor bitmap alone decides order.
   * @param scores - Result scores, or null when all are absent.
   * @param scorePresent - Score validity bits, or null when all supplied scores are present.
   * @param afterAnchor - Result positions after the anchor by document ID, or by sort values followed by document ID when sorted.
   * @param anchorScore - The anchor score, or null when absent.
   * @returns The start position, count when exhausted, or a negative core status.
   */
  pageStart(
    count: number,
    sorted: boolean,
    scores: Float64Array | null,
    scorePresent: Uint32Array | null,
    afterAnchor: Uint32Array,
    anchorScore: number | null,
  ): number
}
