/*
 * Stop words sourced from:
 *   - Grammatical function words and pronouns curated for Narsil
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  "'o",
  'a',
  "a'e",
  "a'u",
  'ae',
  'afai',
  'ai',
  'atu',
  'aua',
  'e',
  "fo'i",
  'i',
  'ia',
  'ifo',
  'ina',
  'isi',
  'lana',
  'latou',
  'laua',
  'lava',
  'le',
  'lē',
  'lea',
  'lena',
  'lenei',
  "lo'u",
  'lona',
  'lou',
  'ma',
  'mai',
  'matou',
  'maua',
  'mo',
  'na',
  'nei',
  'ni',
  'nisi',
  'o',
  'oe',
  'ona',
  'pea',
  "po'o",
  'sa',
  'sā',
  'se',
  'tatou',
  'taua',
  'te',
  'toe',
  'ua',
  'uma',
])

/**
 * Samoan analysis: the stop word list and the rules that split Samoan
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `samoan`.
 *
 * @public
 */
export const samoan: LanguageModule = {
  name: 'samoan',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: { splitPattern: /[^\p{Script=Latin}0-9']+/giu },
}
