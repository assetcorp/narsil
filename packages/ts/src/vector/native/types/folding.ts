import type { NativeExpansionSegment } from './expansion'
import type { NativePartialRequest, NativePartialSource } from './partial-expansion'

/** A handle to the core's fold table of one keyword segment, which the core frees with the handle. @internal */
export type NativeFoldTableHandle = object

/** One query word that folded matching looks up. @internal */
export interface NativeFoldedWord {
  /** The key of the word as written, from {@link NativeFoldingCore.foldSpelling} with stemming. */
  key: Uint16Array
  /** The query token, which the core leaves out of both lists. */
  own: Uint16Array
  /** The tokens that the core leaves out of both lists, such as the word's synonyms. */
  excluded: readonly Uint16Array[]
  /** The edit distance of the typo matches, or 0 for none. */
  tolerance: number
  /** The leading code points that a typo match must share. */
  prefixLength: number
}

/** The native operations of folded matching. @internal */
export interface NativeFoldingCore {
  /**
   * Returns an empty fold table, which each folded operation brings up to date with its segment.
   * @returns The table's handle.
   */
  createFoldTable(): NativeFoldTableHandle

  /**
   * Returns the fold of one spelling, or its key where `flags` sets stemming.
   * @param language - The index of the language module.
   * @param flags - The stem bit from the core's header, or 0.
   * @param spelling - The spelling.
   * @returns The fold or the key, or a negative status code from the core's header.
   */
  foldSpelling(language: number, flags: number, spelling: string): string | number

  /**
   * Returns the variants and the folded typo matches of each word, as two blocks per word.
   * @param segments - Every keyword segment of the partition and its current removal counts.
   * @param tables - The fold table of each segment, in the same order.
   * @param language - The index of the language module.
   * @param words - The query words in order.
   * @param outSegments - Receives the source segment index of each token.
   * @param outTokens - Receives the term ordinal in that source segment.
   * @param outStarts - Receives two offsets per word and the terminal offset.
   * @returns The token count, or a negative status that leaves every output unchanged.
   */
  expandFoldedTerms(
    segments: readonly NativeExpansionSegment[],
    tables: readonly NativeFoldTableHandle[],
    language: number,
    words: readonly NativeFoldedWord[],
    outSegments: Uint32Array,
    outTokens: Uint32Array,
    outStarts: Uint32Array,
  ): number

  /**
   * Returns up to 50 completions of the typed word and of its fold, chosen as the prefix expansion chooses them.
   * @param segments - Every keyword segment of the partition and its current removal counts.
   * @param tables - The fold table of each segment, in the same order.
   * @param language - The index of the language module.
   * @param typed - The unstemmed last query word in UTF-16.
   * @param stemmed - The stemmed last query word.
   * @param own - The query token whose code point length determines each completion's factor.
   * @param folded - The fold of `typed`.
   * @param outSegments - Receives the source segment index of each completion.
   * @param outTokens - Receives the term ordinal in that source segment.
   * @param outFactors - Receives each completion's binary64 factor.
   * @returns The completion count, or a negative status that leaves every output unchanged.
   */
  expandFoldedPrefix(
    segments: readonly NativeExpansionSegment[],
    tables: readonly NativeFoldTableHandle[],
    language: number,
    typed: Uint16Array,
    stemmed: Uint16Array,
    own: Uint16Array,
    folded: Uint16Array,
    outSegments: Uint32Array,
    outTokens: Uint32Array,
    outFactors: Float64Array,
  ): number

  /**
   * Returns the partial-word additions of each request, matching the fold of each written word.
   * @param sources - Every keyword segment of the partition and its spelling index.
   * @param tables - The fold table of each segment, in the same order.
   * @param language - The index of the language module.
   * @param requests - The analysed words in query order, including their typo exclusions.
   * @param folded - The fold of each request's written word.
   * @param outStarts - Receives one offset per request and the terminal offset.
   * @param outSegments - Receives the source segment index of each addition.
   * @param outTokens - Receives the term ordinal in that source segment.
   * @param outFactors - Receives each addition's binary64 factor.
   * @returns The addition count, or a negative status that leaves every output unchanged.
   */
  expandFoldedPartialWords(
    sources: readonly NativePartialSource[],
    tables: readonly NativeFoldTableHandle[],
    language: number,
    requests: readonly NativePartialRequest[],
    folded: readonly Uint16Array[],
    outStarts: Uint32Array,
    outSegments: Uint32Array,
    outTokens: Uint32Array,
    outFactors: Float64Array,
  ): number
}
