/*
 * Stop words sourced from:
 *   - Grammatical function words and pronouns curated for Narsil
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'aiva',
  'akanga',
  'anga',
  'apa',
  'apo',
  'ari',
  'asi',
  'ava',
  'avo',
  'chake',
  'changu',
  'chimwe',
  'chiri',
  'dzake',
  'dzimwe',
  'dzose',
  'here',
  'ichi',
  'icho',
  'idzi',
  'idzo',
  'imi',
  'imwe',
  'ini',
  'ipapo',
  'iri',
  'iro',
  'isu',
  'ivo',
  'iwe',
  'iye',
  'iyi',
  'iyo',
  'izvi',
  'izvo',
  'kana',
  'kune',
  'kunze',
  'kuti',
  'mukati',
  'mumwe',
  'mune',
  'mushure',
  'nekuti',
  'nokuti',
  'ose',
  'pakati',
  'pamusoro',
  'pane',
  'pasi',
  'rimwe',
  'saka',
  'sei',
  'shure',
  'uko',
  'uye',
  'uyo',
  'uyu',
  'vamwe',
  'vari',
  'vose',
  'wake',
  'wako',
  'wangu',
  'wavo',
  'wedu',
  'wenyu',
  'yake',
  'yako',
  'yangu',
  'yavo',
  'yedu',
  'yenyu',
  'zvake',
  'zvangu',
  'zvimwe',
  'zvino',
  'zviri',
  'zvose',
])

/**
 * Shona analysis: the stop word list and the rules that split Shona
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `shona`.
 *
 * @public
 */
export const shona: LanguageModule = {
  name: 'shona',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9]+/gi },
}
