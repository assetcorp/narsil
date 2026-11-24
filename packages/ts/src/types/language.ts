/**
 * Everything the engine needs to analyse one language: how to split text into
 * tokens, which words to drop, and how to reduce a word to its stem.
 *
 * Each language is its own module, so a bundle carries only the languages you
 * import. Register one with {@link registerLanguage} before an index names it.
 *
 * @public
 */
export interface LanguageModule {
  /** An index config sets this name as its `language`. */
  name: string
  /**
   * This fingerprints the module's analysis. The engine records it with each
   * index and reports the index as stale once the two differ, which is how a
   * corrected stemmer or stop word list reaches indexes already written.
   */
  revision: string
  /**
   * This reduces one token to the stem the engine indexes and searches on. It
   * is `null` for a language the project analyses no further than its
   * normaliser.
   */
  stemmer: ((token: string) => string) | null
  /** The engine drops these words before indexing, because they appear too widely to separate one document from another. */
  stopWords: Set<string>
  /** This folds a token's script before stemming, which is where case, diacritics, and lookalike letters are settled. */
  normalizer?: (token: string) => string
  /** These rules split text into tokens, when this language needs something other than the engine's default. */
  tokenizer?: TokenizerConfig
  /**
   * Setting this lets a query typed without marks find the words that carry
   * them, so `oko` finds `ọkọ`, in every index of this language that leaves
   * `foldMarks` unset. The engine stores no extra token for it.
   */
  folding?: LanguageFolding
}

/**
 * How a query typed without marks matches the words of a language that carry
 * them.
 *
 * @public
 */
export interface LanguageFolding {
  /**
   * Each key is a letter that the engine also matches when a query types the
   * value in its place, such as Twi `ɛ` typed as `e`. Every key and every value
   * holds one code point.
   */
  letters?: Readonly<Record<string, string>>
}

/**
 * How the engine splits text into tokens for one language.
 *
 * Leave every field unset to accept the engine's default rules, which suit a
 * space-separated script written in words.
 *
 * @public
 */
export interface TokenizerConfig {
  /** The engine splits on this pattern, which a script without spaces between words replaces. */
  splitPattern?: RegExp
  /** Setting this folds accented letters onto their base letters, so `café` and `cafe` match. */
  normalizeDiacritics?: boolean
  /** The engine drops a token shorter than this, which keeps stray fragments out of the index. */
  minTokenLength?: number
  /** Setting this strips a trailing possessive, so `reader's` indexes as `reader`. */
  stripPossessive?: boolean
  /** The engine cuts each run of characters into overlapping n-grams this long, which is how a script without word breaks is indexed. */
  ngramSize?: number
}
