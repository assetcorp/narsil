/*
 * Stop words sourced from:
 *   - Grammatical function words and pronouns curated for Narsil
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'aho',
  'ahy',
  'amin',
  'anao',
  'anay',
  'antsika',
  'any',
  'ao',
  'ary',
  'avokoa',
  'avy',
  'azy',
  'daholo',
  'dia',
  'efa',
  'eto',
  'fa',
  'foana',
  'ho',
  'hoe',
  'ianao',
  'ianareo',
  'ihany',
  'ilay',
  'indrindra',
  'iny',
  'io',
  'ireo',
  'isaky',
  'isika',
  'ity',
  'izahay',
  'izany',
  'izao',
  'izay',
  'izy',
  'ka',
  'koa',
  'mba',
  'mbola',
  'misy',
  'na',
  'no',
  'noho',
  'ny',
  'raha',
  'rehefa',
  'samy',
  'satria',
  'sy',
  'tahaka',
  'tamin',
  'toy',
  'tsy',
  'vao',
])

/**
 * Malagasy analysis: the stop word list and the rules that split Malagasy
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `malagasy`.
 *
 * @public
 */
export const malagasy: LanguageModule = {
  name: 'malagasy',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: { splitPattern: /[^\p{Script=Latin}0-9]+/giu },
}
