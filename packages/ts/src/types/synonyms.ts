/**
 * A two-way rule makes every word in `words` a synonym of every other word in
 * the rule, so a search for any one of them also matches documents that hold
 * the others.
 *
 * @public
 */
export interface TwoWaySynonymRule {
  /** The rule holds from 2 to 100 words, and each word must analyse to exactly one token. */
  words: string[]
}

/**
 * A one-way rule adds each word in `synonyms` to a search for `word`, while a
 * search for one of those synonyms gains nothing from the rule.
 *
 * @public
 */
export interface OneWaySynonymRule {
  /** A search for this word also matches the words in `synonyms`. */
  word: string
  /** The rule holds from 1 to 99 synonyms, and each one must analyse to exactly one token. */
  synonyms: string[]
}

/**
 * One rule of a synonym set, which {@link IndexConfig.synonyms} and
 * {@link Narsil.updateSynonyms} take as a list.
 *
 * The engine analyses every word with the language, the tokeniser, and the
 * stop words of the index, so a rule that says `jackets` also matches
 * `jacket` wherever the index stems the two alike. A set can hold up to
 * 100,000 rules, 500,000 words, and 4,194,304 bytes of words in UTF-8.
 *
 * @public
 */
export type SynonymRule = TwoWaySynonymRule | OneWaySynonymRule

/**
 * An app passes an object of this type to {@link registerSynonyms} to give the
 * engine its synonym code, which a search uses to expand each query word with
 * the synonyms that the index's set holds for it.
 *
 * A Node process loads this code by itself. A browser bundle contains it only
 * when the app imports `synonyms` from `@delali/narsil/synonyms`, so a bundler
 * can leave it out of an app whose indexes hold no synonym set.
 *
 * @public
 */
export interface SynonymSearch {
  /** The engine checks that this name is `'synonyms'` when an app registers the object. */
  readonly name: 'synonyms'
}
