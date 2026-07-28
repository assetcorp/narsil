/*
 * Stop words compiled from:
 *   - LearnAkan pronouns reference (https://learnakan.com/akan-pronouns/)
 *   - LearnAkan conjunctions reference (https://learnakan.com/akan-asante-twi-conjunctions/)
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'me',
  'wo',
  'ɔno',
  'ɛno',
  'yɛn',
  'mo',
  'wɔn',
  'no',
  'ne',
  'na',
  'nanso',
  'nti',
  'anaa',
  'ansa',
  'sɛ',
  'asɛ',
  'ɛfiri',
  'ɛsiane',
  'sɛdeɛ',
  'mpo',
  'kyɛn',
  'a',
  'yi',
  'de',
  'yɛ',
  'nso',
  'ma',
  'fi',
  'kɔ',
  'ba',
  'ka',
  'bi',
  'mu',
  'so',
  'ho',
  'ase',
  'fa',
  'hwe',
  'bɛ',
  're',
  'ara',
  'paa',
  'kakra',
  'wei',
  'eyi',
  'eno',
  'emu',
  'eso',
  'eho',
  'nyinaa',
  'obi',
  'obiara',
  'hwee',
  'ankasa',
  'nkoraa',
  'te',
  'san',
  'kyerɛ',
  'da',
  'akyire',
  'bere',
  'se',
  'enti',
  'oo',
  'mmom',
  'korɔ',
  'gye',
  'nye',
  'nnye',
])

const GREEK_EPSILON = /ε/g
const OPEN_O_LOOKALIKES = /[ͻↄכ]/g
const TWI_OPEN_E = 'ɛ'
const TWI_OPEN_O = 'ɔ'

function normalize(token: string): string {
  return token.replace(GREEK_EPSILON, TWI_OPEN_E).replace(OPEN_O_LOOKALIKES, TWI_OPEN_O)
}

export const twi: LanguageModule = {
  name: 'twi',
  stemmer: null,
  stopWords,
  normalizer: normalize,
  tokenizer: {
    splitPattern: /[^a-zA-ZɛɔƐƆŋŊεͻↄכ0-9\p{M}']+/giu,
    normalizeDiacritics: false,
    minTokenLength: 1,
  },
}
