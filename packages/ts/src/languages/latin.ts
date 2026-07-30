/*
 * Stop words sourced from:
 *   - stopwords-iso/stopwords-la (https://github.com/stopwords-iso), MIT
 */

import type { LanguageModule } from '../types/language'
import { removeMarks } from './support/marks'

const stopWords = new Set([
  'a',
  'ab',
  'ac',
  'ad',
  'at',
  'atque',
  'aut',
  'autem',
  'cum',
  'de',
  'dum',
  'e',
  'erant',
  'erat',
  'est',
  'et',
  'etiam',
  'ex',
  'haec',
  'hic',
  'hoc',
  'in',
  'ita',
  'me',
  'nec',
  'neque',
  'non',
  'per',
  'qua',
  'quae',
  'quam',
  'qui',
  'quibus',
  'quidem',
  'quo',
  'quod',
  're',
  'rebus',
  'rem',
  'res',
  'sed',
  'si',
  'sic',
  'sunt',
  'tamen',
  'tandem',
  'te',
  'ut',
  'vel',
])

const MACRON = /\u0304/g

function normalize(token: string): string {
  return removeMarks(token, MACRON)
}

export const latin: LanguageModule = {
  name: 'latin',
  stemmer: null,
  stopWords,
  normalizer: normalize,
  tokenizer: { splitPattern: /[^a-z0-9āēīōū]+/gi },
}
