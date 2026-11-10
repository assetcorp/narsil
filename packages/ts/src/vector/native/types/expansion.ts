import type { NativeFrozenSegment, NativeFrozenSegmentState } from './frozen-segments'
import type { NativePartialExpansionCore } from './partial-expansion'
import type { NativeGrowingSegment } from './segments'

/** The keyword regions and removal state of one query expansion source. @internal */
export interface NativeExpansionSegment {
  /** The mutable keyword regions, or null for a frozen source. */
  growing: NativeGrowingSegment | null
  /** The immutable keyword regions, or null for a growing source. */
  frozen: NativeFrozenSegment | null
  /** The frozen source's removal counts, or null for a growing source. */
  state: NativeFrozenSegmentState | null
  /** The frozen term totals by payload slot, when the source keeps its postings on disk. */
  occurrences?: Float64Array | null
}

/** The native operations that expand analysed query words. @internal */
export interface NativeExpansionCore extends NativePartialExpansionCore {
  /**
   * Returns term suggestions by document frequency and then code point order.
   * @param segments - Every keyword segment of the partition and its current removal counts.
   * @param typed - The unstemmed prefix in UTF-16.
   * @param stemmed - The stemmed prefix, used in segments without surface forms.
   * @param limit - The maximum number of suggestions.
   * @param outTerms - Receives triples of source index, term ordinal, and document frequency.
   * @param outStarts - Receives one spelling offset per suggestion and the terminal offset.
   * @param outSpellings - Receives triples of source index, kind, and ordinal. Kind 0 identifies a token and kind 1 a surface form.
   * @param outOccurrences - Receives each spelling's summed occurrence count, in spelling order.
   * @returns The suggestion count, or a negative status that leaves every output unchanged.
   */
  suggestTerms(
    segments: readonly NativeExpansionSegment[],
    typed: Uint16Array,
    stemmed: Uint16Array,
    limit: number,
    outTerms: Uint32Array,
    outStarts: Uint32Array,
    outSpellings: Uint32Array,
    outOccurrences: Float64Array,
  ): number

  /**
   * Returns up to 50 completions by partition document frequency and then code point order.
   * @param segments - Every keyword segment of the partition and its current removal counts.
   * @param typed - The unstemmed last query word in UTF-16.
   * @param stemmed - The stemmed last query word, used when the partition has no surface forms.
   * @param own - The query token whose code point length determines each completion's factor.
   * @param outSegments - Receives the source segment index of each completion.
   * @param outTokens - Receives the term ordinal in that source segment.
   * @param outFactors - Receives each completion's binary64 factor.
   * @returns The completion count, or a negative status that leaves every output unchanged.
   */
  expandPrefix(
    segments: readonly NativeExpansionSegment[],
    typed: Uint16Array,
    stemmed: Uint16Array,
    own: Uint16Array,
    outSegments: Uint32Array,
    outTokens: Uint32Array,
    outFactors: Float64Array,
  ): number
}
