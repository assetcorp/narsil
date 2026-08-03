/*
 * Stop words sourced from:
 *   - Grammatical function words and pronouns curated for Narsil
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'aba',
  'abandi',
  'abo',
  'aho',
  'aka',
  'ako',
  'ari',
  'ariko',
  'aya',
  'ayo',
  'bari',
  'bo',
  'bose',
  'bw',
  'c',
  'cane',
  'canke',
  'gusa',
  'hagati',
  'hanyuma',
  'hari',
  'hasi',
  'hejuru',
  'hose',
  'ibi',
  'ibindi',
  'ico',
  'iki',
  'ikindi',
  'imbere',
  'inyuma',
  'iri',
  'iryo',
  'ivyo',
  'iyi',
  'iyo',
  'izindi',
  'izo',
  'jewe',
  'kandi',
  'ku',
  'kubera',
  'kuko',
  'kuri',
  'mu',
  'muri',
  'mwebwe',
  'mwese',
  'n',
  'na',
  'ndi',
  'ni',
  'nka',
  'no',
  'nta',
  'rw',
  'si',
  'turi',
  'twebwe',
  'twese',
  'u',
  'ubu',
  'uku',
  'ukwo',
  'uri',
  'uru',
  'urwo',
  'utu',
  'utwo',
  'uwo',
  'uwundi',
  'uyu',
  'vy',
  'vyose',
  'we',
  'wewe',
  'y',
  'yari',
  'yose',
  'zose',
])

/**
 * Kirundi analysis: the stop word list and the rules that split Kirundi
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `kirundi`.
 *
 * @public
 */
export const kirundi: LanguageModule = {
  name: 'kirundi',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9]+/gi },
}
