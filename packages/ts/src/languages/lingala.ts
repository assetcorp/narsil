/*
 * Stop words sourced from:
 *   - Grammatical function words and pronouns curated for Narsil
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'awa',
  'azalaki',
  'azali',
  'bango',
  'basusu',
  'bazali',
  'bino',
  'biso',
  'bongo',
  'boye',
  'epai',
  'ezalaki',
  'ezali',
  'kaka',
  'kasi',
  'kati',
  'kuna',
  'liboso',
  'likolo',
  'lisusu',
  'lokola',
  'mingi',
  'misusu',
  'moko',
  'mosusu',
  'mpe',
  'mpo',
  'na',
  'naino',
  'nazali',
  'ngai',
  'nse',
  'nsima',
  'nyonso',
  'oyo',
  'ozali',
  'pe',
  'sikawa',
  'sikoyo',
  'sima',
  'soki',
  'te',
  'tii',
  'to',
  'tozali',
  'wana',
  'ya',
  'ye',
  'yo',
])

/**
 * Lingala analysis: the stop word list and the rules that split Lingala
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `lingala`.
 *
 * @public
 */
export const lingala: LanguageModule = {
  name: 'lingala',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: { splitPattern: /[^\p{Script=Latin}\p{M}0-9]+/giu },
}
