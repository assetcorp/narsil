/*
 * Stop words sourced from:
 *   - Grammatical function words and pronouns curated for Narsil
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'a',
  'abada',
  'ale',
  'an',
  'ani',
  'aw',
  'bɛ',
  'bɛɛ',
  'caman',
  'de',
  'don',
  'dɔ',
  'dɔɔni',
  'dɔrɔn',
  'fana',
  'fɛ',
  'fo',
  'hali',
  'i',
  'ka',
  'kabini',
  'ko',
  'kosɛbɛ',
  'kɔ',
  'kɔfɛ',
  'kɔnɔ',
  'la',
  'min',
  'minnu',
  'na',
  'ne',
  'ni',
  'nin',
  'ninnu',
  'nka',
  'o',
  'olu',
  'sanfɛ',
  'sisan',
  'tɛ',
  'tugun',
  'u',
  'wa',
  'walima',
  'yan',
  'ye',
  'yen',
  'yɛrɛ',
])

/**
 * Bambara analysis: the stop word list and the rules that split Bambara
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `bambara`.
 *
 * @public
 */
export const bambara: LanguageModule = {
  name: 'bambara',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: { splitPattern: /[^\p{Script=Latin}0-9]+/giu },
}
