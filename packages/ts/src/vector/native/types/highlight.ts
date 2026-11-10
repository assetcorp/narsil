/** The analysed words that determine which text spans receive highlight tags. @internal */
export interface NativeHighlightQuery {
  /** The stemmed query words and the edit distance that each word permits. */
  terms: readonly { term: Uint16Array; tolerance: number }[]
  /** The number of leading code points that a fuzzy match must preserve. */
  prefixLength: number
  /** The unstemmed final query word, or null when prefix matching is disabled. */
  prefix: Uint16Array | null
  /** The stemmed synonyms and phrase words that match exactly. */
  synonyms: readonly Uint16Array[]
  /** The words that may match inside longer written spellings. */
  partialWords: readonly Uint16Array[] | null
}

/** The native operation that marks matching spans in the original text. @internal */
export interface NativeHighlightCore {
  /**
   * Returns highlighted text and its positions in the original UTF-16 text.
   * @param language - The built-in language index.
   * @param text - The original text in UTF-16.
   * @param query - The analysed words and their matching rules.
   * @param preTag - The UTF-16 text before each matching span.
   * @param postTag - The UTF-16 text after each matching span.
   * @param maxSnippetLength - The window length before tags and ellipses, or zero for the full text.
   * @param outSnippet - Receives the snippet's UTF-16 units.
   * @param outPositions - Receives pairs of start and end positions in the original text.
   * @param outLength - Receives the snippet's unit count in its first element.
   * @returns The position count, or a negative status that leaves every output unchanged.
   */
  highlight(
    language: number,
    text: Uint16Array,
    query: NativeHighlightQuery,
    preTag: Uint16Array,
    postTag: Uint16Array,
    maxSnippetLength: number,
    outSnippet: Uint16Array,
    outPositions: Uint32Array,
    outLength: Uint32Array,
  ): number
}
