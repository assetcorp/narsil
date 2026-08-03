/*
 * Stop words sourced from:
 *   - Grammatical function words and pronouns curated for Narsil
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'au',
  'baleta',
  'dua',
  'e',
  'ena',
  'era',
  'ga',
  'ia',
  'iko',
  'ira',
  'ka',
  'ke',
  'kece',
  'kecega',
  'keda',
  'kei',
  'keimami',
  'kemuni',
  'kena',
  'ki',
  'koya',
  'mai',
  'me',
  'na',
  'ni',
  'nodra',
  'nomu',
  'nona',
  'noqu',
  'o',
  'oqo',
  'oya',
  'rawa',
  'sa',
  'sara',
  'se',
  'sega',
  'so',
  'talega',
  'tiko',
  'tu',
  'vei',
  'yani',
])

/**
 * Fijian analysis: the stop word list and the rules that split Fijian
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `fijian`.
 *
 * @public
 */
export const fijian: LanguageModule = {
  name: 'fijian',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9]+/gi },
}
