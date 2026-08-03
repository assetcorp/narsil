/*
 * Stop words sourced from:
 *   - spaCy Kurmanji Kurdish stop words (https://github.com/explosion/spaCy), MIT
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'bi',
  'çawa',
  'çend',
  'çi',
  'çima',
  'çiqas',
  'da',
  'de',
  'di',
  'em',
  'ev',
  'ew',
  'ez',
  'gelek',
  'hemû',
  'her',
  'hin',
  'hûn',
  'ji',
  'kê',
  'kengî',
  'kes',
  'kî',
  'ku',
  'li',
  'me',
  'min',
  'te',
  'tişt',
  'tu',
  'û',
  'va',
  'vê',
  'vî',
  'wan',
  'we',
  'wê',
  'wî',
])

/**
 * Kurmanji analysis: the stop word list and the rules that split Kurmanji
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `kurmanji`.
 *
 * @public
 */
export const kurmanji: LanguageModule = {
  name: 'kurmanji',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9çêîşû]+/gi },
}
