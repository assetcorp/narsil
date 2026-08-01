/*
 * Stop words curated for Narsil; no published Ga stop word list exists. Consulted:
 *   - "Giving Reference to the Pronominal 'e' in Ga"
 *     (https://www.iiste.org/Journals/index.php/RHSS/article/download/38736/39836)
 *   - Omniglot Ga reference (https://www.omniglot.com/writing/ga.htm), copyright Simon Ager
 *
 * Ga has limited NLP resources; this list may benefit from review by native speakers.
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'mi',
  'bo',
  'e',
  'wɔ',
  'ni',
  'amɛ',
  'lɛ',
  'mɔ',
  'nɔ',
  'he',
  'le',
  'kɛ',
  'shi',
  'ba',
  'yɛ',
  'ko',
  'tso',
  'tsɔ',
  'naa',
  'nɛɛ',
  'fee',
  'kane',
  'shishi',
  'moko',
  'lo',
  'la',
  'mo',
  'ji',
  'ana',
  'mli',
  'nii',
  'noko',
  'ahi',
  'kome',
  'eno',
  'eni',
  'bee',
  'tee',
  'laa',
  'nee',
  'no',
  'nu',
  'ne',
  'na',
  'ta',
  'fo',
  'esa',
  'bii',
  'saa',
  'fɛɛ',
  'akɛ',
  'yaanɔ',
  'eee',
  'ekome',
])

export const ga: LanguageModule = {
  name: 'ga',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: {
    splitPattern: /[^a-zA-ZɛɔƐƆŋŊãÃ0-9\p{M}]+/giu,
    normalizeDiacritics: false,
    minTokenLength: 1,
  },
}
