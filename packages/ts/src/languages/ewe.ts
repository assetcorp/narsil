/*
 * Stop words curated for Narsil; no published Ewe stop word list exists. Consulted:
 *   - LinguaShop Ewe pronouns (https://www.linguashop.com/ewe-personal-pronouns), no licence stated
 *   - MustGo Ewe language reference (https://www.mustgo.com/worldlanguages/ewe/), all rights reserved
 *   - Wiktionary Ewe pronouns category (https://en.wiktionary.org/wiki/Category:Ewe_pronouns), CC-BY-SA
 */

import type { LanguageModule } from '../types/language'
import { withNormalisedSpellings } from './support/spellings'

const stopWords = new Set([
  'nye',
  'nyè',
  'wò',
  'eya',
  'mí',
  'míawo',
  'wó',
  'woawo',
  'la',
  'le',
  'be',
  'ne',
  'si',
  'wo',
  'ame',
  'nu',
  'aɖe',
  'na',
  'tso',
  'yi',
  'va',
  'eye',
  'kple',
  'alo',
  'gake',
  'ke',
  'elabena',
  'eyata',
  'hafi',
  'ale',
  'sia',
  'ma',
  'esia',
  'ema',
  'esiwo',
  'emawo',
  'de',
  'me',
  'dzi',
  'te',
  'dome',
  'megbe',
  'ŋgɔ',
  'dzo',
  'do',
  'afi',
  'afisi',
  'katã',
  'kataa',
  'ɖe',
  'nuka',
  'ameka',
  'fitee',
  'aleke',
  'gbɔ',
  'ko',
  'ha',
  'hã',
  'ga',
  'hee',
  'a',
  'o',
  'e',
  'ewo',
  'nenie',
  'kpɔ',
  'vɔ',
  'se',
  'tsoa',
  'hena',
])

const ICELANDIC_ETH = /\u00F0/g
const EWE_D = '\u0256'

function normalize(token: string): string {
  return token.replace(ICELANDIC_ETH, EWE_D)
}

export const ewe: LanguageModule = {
  name: 'ewe',
  stemmer: null,
  stopWords: withNormalisedSpellings(stopWords, normalize),
  normalizer: normalize,
  tokenizer: {
    splitPattern: /[^a-zA-ZàáèéêìíòóùúãẽĩũɛɔɖƉðÐŋƐƆŊɣƔƒƑʋƲÀÁÈÉÊÌÍÒÓÙÚÃẼĨŨ0-9\p{M}]+/giu,
    normalizeDiacritics: false,
    minTokenLength: 1,
  },
}
