/*
 * Stop words sourced from:
 *   - Grammatical function words and pronouns curated for Narsil
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'ak',
  'am',
  'ba',
  'ban',
  'beneen',
  'benn',
  'bi',
  'bii',
  'boobu',
  'bu',
  'ca',
  'ci',
  'dafa',
  'dina',
  'du',
  'fa',
  'fi',
  'fu',
  'gi',
  'it',
  'itam',
  'ji',
  'ki',
  'kon',
  'ku',
  'la',
  'lépp',
  'li',
  'lool',
  'lu',
  'ma',
  'man',
  'mi',
  'moom',
  'mu',
  'na',
  'naa',
  'nañu',
  'ndax',
  'ndaxte',
  'ne',
  'ñépp',
  'nga',
  'ngeen',
  'ni',
  'ñi',
  'ñoom',
  'ñu',
  'nun',
  'rekk',
  'sa',
  'sama',
  'seen',
  'si',
  'su',
  'sunu',
  'te',
  'waaye',
  'walla',
  'wi',
  'yeen',
  'yeneen',
  'yépp',
  'yi',
  'yii',
  'yooyu',
  'yow',
])

/**
 * Wolof analysis: the stop word list and the rules that split Wolof
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `wolof`.
 *
 * @public
 */
export const wolof: LanguageModule = {
  name: 'wolof',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: { splitPattern: /[^\p{Script=Latin}0-9]+/giu },
}
