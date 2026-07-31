/*
 * Stop words sourced from:
 *   - Apache Lucene ckb stopwords, from "Building a Test Collection for Sorani Kurdish"
 *     by Esmaili et al. (https://github.com/apache/lucene), Apache-2.0
 *   - The heh doachashmee spellings of هەر and هەروەها added for Narsil, because
 *     Sorani Wikipedia writes ھ 140 times against ه 42 across 60 sampled articles
 *
 * Normalization ports Apache Lucene's SoraniNormalizer (Apache-2.0).
 */

import type { LanguageModule } from '../types/language'
import { withNormalisedSpellings } from './support/spellings'

const stopWords = new Set([
  'ئەم',
  'ئەو',
  'ئەوان',
  'ئەوەی',
  'ئێمە',
  'ئێوە',
  'بە',
  'بەبێ',
  'بەپێی',
  'بەدەم',
  'بەردەم',
  'بەرلە',
  'بەرەوە',
  'بەرەوی',
  'بەلای',
  'بۆ',
  'بێ',
  'بێجگە',
  'پاش',
  'پێ',
  'پێش',
  'تۆ',
  'تێ',
  'جگە',
  'چەند',
  'دە',
  'دەکات',
  'دەگەڵ',
  'دوای',
  'دوو',
  'سەر',
  'کرد',
  'کە',
  'لە',
  'لەبابەت',
  'لەباتی',
  'لەبارەی',
  'لەبرێتی',
  'لەبن',
  'لەبەر',
  'لەبەینی',
  'لەپێناوی',
  'لەدەم',
  'لەرەوی',
  'لەرێ',
  'لەرێگا',
  'لەژێر',
  'لەسەر',
  'لەگەڵ',
  'لەلایەن',
  'لەناو',
  'لەنێو',
  'لەو',
  'لێ',
  'من',
  'ناو',
  'نێوان',
  'هەر',
  'هەروەها',
  'ھەر',
  'ھەروەھا',
  'و',
  'وەک',
  'ی',
])

const YEH = '\u064a'
const DOTLESS_YEH = '\u0649'
const FARSI_YEH = '\u06cc'
const KAF = '\u0643'
const KEHEH = '\u06a9'
const HEH = '\u0647'
const AE = '\u06d5'
const ZWNJ = '\u200c'
const HEH_DOACHASHMEE = '\u06be'
const TEH_MARBUTA = '\u0629'
const REH = '\u0631'
const RREH = '\u0695'
const RREH_ABOVE = '\u0692'
const TATWEEL = '\u0640'
const FATHATAN = '\u064b'
const DAMMATAN = '\u064c'
const KASRATAN = '\u064d'
const FATHA = '\u064e'
const DAMMA = '\u064f'
const KASRA = '\u0650'
const SHADDA = '\u0651'
const SUKUN = '\u0652'

const FORMAT_CHARACTER = /\p{Cf}/u
const REWRITTEN = /[\u0629\u0631\u0640\u064b-\u0652\u0649\u064a\u0643\u0647\u0692\u06be]|\p{Cf}/u

function normalize(token: string): string {
  if (!REWRITTEN.test(token)) return token

  const chars = Array.from(token)
  for (let i = 0; i < chars.length; i++) {
    switch (chars[i]) {
      case YEH:
      case DOTLESS_YEH:
        chars[i] = FARSI_YEH
        break
      case KAF:
        chars[i] = KEHEH
        break
      case ZWNJ:
        if (i > 0 && chars[i - 1] === HEH) chars[i - 1] = AE
        chars.splice(i, 1)
        i--
        break
      case HEH:
        if (i === chars.length - 1) chars[i] = AE
        break
      case TEH_MARBUTA:
        chars[i] = AE
        break
      case HEH_DOACHASHMEE:
        chars[i] = HEH
        break
      case REH:
        if (i === 0) chars[i] = RREH
        break
      case RREH_ABOVE:
        chars[i] = RREH
        break
      case TATWEEL:
      case FATHATAN:
      case DAMMATAN:
      case KASRATAN:
      case FATHA:
      case DAMMA:
      case KASRA:
      case SHADDA:
      case SUKUN:
        chars.splice(i, 1)
        i--
        break
      default:
        if (FORMAT_CHARACTER.test(chars[i])) {
          chars.splice(i, 1)
          i--
        }
    }
  }
  return chars.join('')
}

export const sorani: LanguageModule = {
  name: 'sorani',
  revision: '1',
  stemmer: null,
  stopWords: withNormalisedSpellings(stopWords, normalize),
  normalizer: normalize,
  tokenizer: { splitPattern: /[^\u0621-\u065f\u0660-\u0669\u066e-\u06d5\u06f0-\u06f9\u200ca-z0-9]+/gi },
}
