import type { NativeExpansionSegment } from './expansion'

/** The frozen spelling index that narrows substring candidates. @internal */
export interface NativeFrozenRuns {
  /** Three Unicode code points per run, in ascending order. */
  runs: Uint32Array
  /** The member offsets, including the terminal offset. */
  offsets: Uint32Array
  /** The spelling ordinals of each run. */
  members: Uint32Array
}

/** The keyword and spelling regions of one partial-word source. @internal */
export interface NativePartialSource {
  /** The keyword regions and their current removal counts. */
  segment: NativeExpansionSegment
  /** The frozen run index, or null for a growing source or an absent spelling table. */
  runs: NativeFrozenRuns | null
}

/** The analysed words and typo settings of one partial-word request. @internal */
export interface NativePartialRequest {
  /** The unstemmed word in UTF-16. */
  written: Uint16Array
  /** The indexed query token in UTF-16. */
  own: Uint16Array
  /** The edit distance whose matches must be excluded. */
  tolerance: number
  /** The leading code points that a typo match must share. */
  prefixLength: number
}

/** The native operation that selects partial-word additions. @internal */
export interface NativePartialExpansionCore {
  /**
   * Returns additions by partition document frequency and then code point order.
   * Divides 50 additions among the first 50 requests whose written words have at least three code points.
   * @param sources - Every keyword segment of the partition and its spelling index.
   * @param requests - The analysed words in query order, including their typo exclusions.
   * @param outStarts - Receives one offset per request and the terminal offset.
   * @param outSegments - Receives the source segment index of each addition.
   * @param outTokens - Receives the term ordinal in that source segment.
   * @param outFactors - Receives each addition's binary64 factor.
   * @returns The addition count, or a negative status that leaves every output unchanged.
   */
  expandPartialWords(
    sources: readonly NativePartialSource[],
    requests: readonly NativePartialRequest[],
    outStarts: Uint32Array,
    outSegments: Uint32Array,
    outTokens: Uint32Array,
    outFactors: Float64Array,
  ): number
}
