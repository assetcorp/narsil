/*
 * Stop words sourced from:
 *   - Grammatical function words and pronouns curated for Narsil
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'a',
  'ahakoa',
  'ahau',
  'ai',
  'ana',
  'anake',
  'anō',
  'au',
  'aua',
  'e',
  'ēnā',
  'ēnei',
  'engari',
  'ērā',
  'ētahi',
  'he',
  'hei',
  'hoki',
  'i',
  'ia',
  'ka',
  'kāhore',
  'kāore',
  'katoa',
  'kaua',
  'kei',
  'ki',
  'kia',
  'ko',
  'koe',
  'kore',
  'kōrua',
  'koutou',
  'kua',
  'mā',
  'mātou',
  'māua',
  'me',
  'mehemea',
  'mō',
  'nā',
  'nei',
  'ngā',
  'nō',
  'o',
  'otirā',
  'pea',
  'rā',
  'rānei',
  'rātou',
  'rāua',
  'taku',
  'tāku',
  'tana',
  'tāna',
  'tātou',
  'taua',
  'tāua',
  'te',
  'tēnā',
  'tēnei',
  'tērā',
  'tētahi',
  'tō',
  'tōku',
  'tōna',
  'tonu',
])

/**
 * Maori analysis: the stop word list and the rules that split Maori
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `maori`.
 *
 * @public
 */
export const maori: LanguageModule = {
  name: 'maori',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: { splitPattern: /[^\p{Script=Latin}0-9]+/giu },
}
