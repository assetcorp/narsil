import type { NativeStoredValues } from './stored-values'

/**
 * The native operations that group hits and combine grouped search results.
 *
 * @internal
 */
export interface NativeGroupCore {
  /**
   * Groups hits by stored field equality and orders groups by their first member's score and document ID.
   *
   * @param values - The stored fields in grouping order, all using the same ordinal space.
   * @param ordinals - The stored ordinal at each input hit position, in final hit order.
   * @param scores - The score at each input hit position, with zero for an absent score.
   * @param idRanks - The document ID rank at each input hit position, in code point order.
   * @param maxPerGroup - The maximum number of retained hits in each group.
   * @param limit - The maximum number of groups, or null to retain every group.
   * @param outHeads - Receives each group's first input hit position, including when maxPerGroup is zero.
   * @param outOffsets - Receives each group's first retained hit offset and the terminal offset, or one zero for no groups.
   * @param outHits - Receives the retained input hit positions in their incoming order within each group.
   * @param outMembers - Receives each group's full member count before truncation.
   * @returns The group count, or a negative core status that leaves inputs and output regions unchanged.
   */
  groupHits(
    values: readonly NativeStoredValues[],
    ordinals: Uint32Array,
    scores: Float64Array,
    idRanks: Uint32Array,
    maxPerGroup: number,
    limit: number | null,
    outHeads: Uint32Array,
    outOffsets: Uint32Array,
    outHits: Uint32Array,
    outMembers: Uint32Array,
  ): number

  /**
   * Merges each group's entries and orders groups by their first retained score and document ID.
   *
   * @param keys - Group identities in source-list order, with repeated identities combined.
   * @param offsets - Each input group's first entry, followed by the total entry count.
   * @param scores - Raw entry scores, or null when every score is absent.
   * @param scorePresent - Bits marking present scores, or null when every supplied score is present.
   * @param ranks - Cross-list entry ranks by sort values and document ID when sorted, or by document ID otherwise.
   * @param idRanks - Cross-list document ID ranks in code point order.
   * @param sorted - Whether ranks determine entry order independently of scores.
   * @param maxPerGroup - The maximum number of entries retained in each group.
   * @param limit - The maximum number of groups returned, or null to retain every group.
   * @param outKeys - Receives the retained group identities in result order.
   * @param outOffsets - Receives each output group's first entry and the final entry count, or one zero for no groups.
   * @param outSources - Receives each retained entry's input group position.
   * @param outIndices - Receives each retained entry's position within its input group.
   * @returns The group count, or a negative core status that leaves inputs and output regions unchanged.
   */
  mergeGroups(
    keys: Uint32Array,
    offsets: Uint32Array,
    scores: Float64Array | null,
    scorePresent: Uint32Array | null,
    ranks: Uint32Array,
    idRanks: Uint32Array,
    sorted: boolean,
    maxPerGroup: number,
    limit: number | null,
    outKeys: Uint32Array,
    outOffsets: Uint32Array,
    outSources: Uint32Array,
    outIndices: Uint32Array,
  ): number
}
