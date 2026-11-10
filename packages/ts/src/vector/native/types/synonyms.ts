/**
 * The analysed synonym rules and the tokens that open each rule.
 *
 * @internal
 */
export interface NativeSynonymTable {
  /** The tokens in UTF-8 and code point order. */
  tokens: Uint8Array
  /** Each token's byte start, followed by the total byte count. */
  offsets: Uint32Array
  /** Each rule's start in ruleTokens, followed by the entry count. */
  ruleStart: Uint32Array
  /** The source token of each one-way rule, or -1 for a two-way rule. */
  ruleSource: Int32Array
  /** The token indexes in each rule. */
  ruleTokens: Uint32Array
  /** Each token's start in tokenRules, followed by the entry count. */
  tokenStart: Uint32Array
  /** The rules that each token opens. */
  tokenRules: Uint32Array
}

/**
 * The operation that expands query tokens through analysed synonym rules.
 *
 * @internal
 */
export interface NativeSynonymCore {
  /**
   * Shares fifty synonyms among distinct query tokens in query order.
   *
   * @param table - The analysed synonym table.
   * @param units - The query tokens in UTF-16.
   * @param starts - Each query token's unit start, followed by the total unit count.
   * @param queries - Receives the input position of each token with synonyms.
   * @param offsets - Receives each returned group's start in tokens, followed by the total entry count.
   * @param tokens - Receives each group's token indexes in code point order, without repeats.
   * @returns The group count, or a negative status that leaves every output unchanged. An empty success writes zero to offsets[0].
   */
  expandSynonyms(
    table: NativeSynonymTable,
    units: Uint16Array,
    starts: Uint32Array,
    queries: Uint32Array,
    offsets: Uint32Array,
    tokens: Uint32Array,
  ): number
}
