/*
 * Stop words sourced from:
 *   - Grammatical function words and pronouns curated for Narsil
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  "'a",
  "'e",
  "'ena",
  "'ene",
  "'eni",
  "'i",
  "'ikai",
  "'o",
  "'oku",
  "'osi",
  'ai',
  'ange',
  'atu',
  'au',
  'e',
  'foki',
  'ha',
  'hake',
  'he',
  'hifo',
  'ho',
  'hoku',
  'hono',
  'ia',
  'ka',
  'kae',
  'kapau',
  'kātoa',
  'ke',
  'ki',
  'ko',
  'koe',
  "koe'uhi",
  'kuo',
  'lolotonga',
  'mai',
  'mei',
  'mo',
  "na'a",
  "na'e",
  'ni',
  'pe',
  'pē',
  'te',
])

/**
 * Tongan analysis: the stop word list and the rules that split Tongan
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `tongan`.
 *
 * @public
 */
export const tongan: LanguageModule = {
  name: 'tongan',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: { splitPattern: /[^\p{Script=Latin}0-9']+/giu },
}
