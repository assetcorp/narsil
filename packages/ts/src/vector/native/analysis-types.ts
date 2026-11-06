/**
 * A set of stop words that the native search core holds, which an analysis call takes in place of the
 * language's own list.
 *
 * @internal
 */
export type NativeStopWordSetHandle = object

/**
 * The text analysis operations of the native search core, which split, normalise, and stem text for every
 * language module that the package ships.
 *
 * @internal
 */
export interface NativeAnalysisCore {
  /** Returns the number of language modules that the core analyses. */
  languageCount(): number
  /**
   * Returns the name of one of the core's language modules.
   *
   * @param language - The module's index, from 0 up to {@link NativeAnalysisCore.languageCount}.
   * @returns The name that the module registers under.
   */
  languageName(language: number): string
  /**
   * Returns the revision of one of the core's language modules, which equals the revision of the TypeScript
   * module with the same name.
   *
   * @param language - The module's index.
   * @returns The module's revision.
   */
  languageRevision(language: number): string
  /**
   * Returns the stop words of one of the core's language modules.
   *
   * @param language - The module's index.
   * @returns Every stop word of the module, in code unit order.
   */
  languageStopWords(language: number): string[]
  /**
   * Gives the core a set of stop words for later analysis calls.
   *
   * @param words - The stop words.
   * @returns The handle that an analysis call takes, which the core releases once nothing refers to it.
   */
  createStopWordSet(words: string[]): NativeStopWordSetHandle
  /**
   * Splits a text into tokens and analyses each one.
   *
   * @param language - The index of the language module to analyse with.
   * @param flags - The analysis steps to take, as bits from the core's header.
   * @param text - The text.
   * @param stopWords - The stop words to remove, or `null` for the module's own list.
   * @param records - The array that receives the token count in its first entry and then seven entries for
   * each token: its position, the offset and length of its term, the offset and length of its surface form
   * (an offset of 0xffffffff where it has none), and the offset and length of its original spelling.
   * @returns The text that every offset points into, `null` where `records` holds too few entries for every
   * token (its first entry then holds the token count), or a negative status code from the core's header.
   */
  analyse(
    language: number,
    flags: number,
    text: string,
    stopWords: NativeStopWordSetHandle | null,
    records: Uint32Array,
  ): string | number | null
  /**
   * Normalises and stems one token without splitting it.
   *
   * @param language - The index of the language module to analyse with.
   * @param flags - The stem and diacritic bits from the core's header.
   * @param token - The token.
   * @returns The transformed token, or a negative status code from the core's header.
   */
  transform(language: number, flags: number, token: string): string | number
}
