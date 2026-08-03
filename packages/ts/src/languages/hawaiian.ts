/*
 * Stop words sourced from:
 *   - Grammatical function words and pronouns curated for Narsil
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  "'a'ohe",
  "'a'ole",
  "'o",
  "'oe",
  "'olua",
  "'oukou",
  'a',
  "a'e",
  'akā',
  'aku',
  'ana',
  'au',
  'e',
  'he',
  "ho'i",
  'i',
  'ia',
  'iā',
  'iho',
  'inā',
  'ka',
  'kā',
  "ka'u",
  'kākou',
  'kāna',
  'kāu',
  'kāua',
  'ke',
  'kēia',
  'kekahi',
  'kēlā',
  'kēnā',
  'ko',
  "ko'u",
  'kona',
  'kou',
  'lākou',
  'lāua',
  'loa',
  'ma',
  'mai',
  'mākou',
  'mau',
  'māua',
  'me',
  'na',
  'nā',
  "na'e",
  'nei',
  'no',
  'nō',
  'o',
  'paha',
  'pū',
  'ua',
  'wale',
  'wau',
])

/**
 * Hawaiian analysis: the stop word list and the rules that split Hawaiian
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `hawaiian`.
 *
 * @public
 */
export const hawaiian: LanguageModule = {
  name: 'hawaiian',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: { splitPattern: /[^\p{Script=Latin}0-9']+/giu },
}
