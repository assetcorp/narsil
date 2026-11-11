/** The regions of a growing UTF-16 term dictionary. @internal */
export interface NativeTermTable {
  /** The eight-word header containing counts, slot capacity, generation, and used text units. */
  header: Uint32Array
  /** The hash slots containing ordinal plus one, zero for empty, or minus one for removed. */
  slots: Int32Array
  /** The text start of each term. */
  termOffset: Uint32Array
  /** The UTF-16 length of each term. */
  termLength: Uint32Array
  /** The next term with the same first unit, plus one, or zero. */
  firstUnitNext: Uint32Array
  /** The first term for each of the 65,536 possible first units, plus one, or zero. */
  firstUnitHead: Uint32Array
  /** The UTF-16 units of the terms. */
  units: Uint16Array
}

/** The regions and live counts of a growing or frozen term dictionary. @internal */
export interface NativeTermDictionary {
  /** The growing table, or null for a frozen dictionary. */
  growing: NativeTermTable | null
  /** The frozen UTF-8 tokens, empty for a growing dictionary. */
  tokens: Uint8Array
  /** The frozen token offsets and final byte length, empty for a growing dictionary. */
  offsets: Uint32Array
  /** The stored document frequency at each term ordinal. */
  frequencies: Uint32Array
  /** The removed document count at each term ordinal. */
  removed: Uint32Array
}

/** The native dictionary operations that preserve live counts and Unicode order. @internal */
export interface NativeTermCore {
  /**
   * Finds an exact live term.
   * @param dictionary - The term regions and removal counts.
   * @param text - The UTF-16 query term.
   * @param output - Receives the ordinal when the term is present.
   * @returns Zero or one, or a negative status that leaves the output unchanged.
   */
  lookupExact(dictionary: NativeTermDictionary, text: Uint16Array, output: Uint32Array): number
  /**
   * Finds each exact live term after validating the dictionary once.
   * @param dictionary - The term regions and removal counts.
   * @param units - The concatenated UTF-16 query terms.
   * @param offsets - The nondecreasing term boundaries, starting at zero and ending at the unit count.
   * @param output - Receives each term ordinal, or UINT32_MAX when absent.
   * @returns The query count, or a negative status that leaves the entire output unchanged.
   */
  lookupExactBatch(
    dictionary: NativeTermDictionary,
    units: Uint16Array,
    offsets: Uint32Array,
    output: Uint32Array,
  ): number
  /**
   * Finds live prefix matches in descending frequency and then code point order.
   * @param dictionary - The term regions and removal counts.
   * @param text - The UTF-16 prefix, which matches nothing when empty.
   * @param limit - The maximum number of matches.
   * @param output - Receives the matching ordinals.
   * @returns The match count, or a negative status that leaves the output unchanged.
   */
  lookupPrefix(dictionary: NativeTermDictionary, text: Uint16Array, limit: number, output: Uint32Array): number
  /**
   * Finds live terms within the edit distance in code point order.
   * @param dictionary - The term regions and removal counts.
   * @param text - The UTF-16 query term.
   * @param tolerance - The maximum Levenshtein distance, or zero for an exact lookup.
   * @param prefixLength - The number of leading query code points that must match.
   * @param output - Receives the matching ordinals.
   * @returns The match count, or a negative status that leaves the output unchanged.
   */
  lookupTypo(
    dictionary: NativeTermDictionary,
    text: Uint16Array,
    tolerance: number,
    prefixLength: number,
    output: Uint32Array,
  ): number
  /**
   * Writes the live document frequency of a term.
   * @param dictionary - The term regions and removal counts.
   * @param ordinal - The term ordinal.
   * @param output - Receives the frequency in its first word.
   * @returns Zero, or a negative status that leaves the output unchanged.
   */
  documentFrequency(dictionary: NativeTermDictionary, ordinal: number, output: Uint32Array): number
}
