/*
 * Stop words curated for Narsil; no published Dagbani stop word list exists. Consulted:
 *   - Mabia VP Periphery Project (https://mabia-vp.com/tiki-index.php?page=Dagbani),
 *     no licence stated
 *
 * Verified preverbal/postverbal pronouns, tense/aspect particles,
 * negation markers, and focus particles.
 */

import type { LanguageModule } from '../types/language'
import { withNormalisedSpellings } from './support/spellings'

const stopWords = new Set([
  'n',
  'a',
  'o',
  'di',
  'ti',
  'yi',
  'bɛ',
  'ŋa',
  'ma',
  'li',
  'ba',
  'ya',
  'mani',
  'nyini',
  'ŋuni',
  'ŋuna',
  'dini',
  'dina',
  'tinima',
  'yinima',
  'bɛna',
  'bana',
  'ŋana',
  'ŋʊn',
  'ni',
  'la',
  'ka',
  'də',
  'sa',
  'daa',
  'na',
  'siri',
  'yaa',
  'dii',
  'bə',
  'nə',
  'ku',
  'de',
  'lah',
  'bi',
  'pa',
  'bee',
  'amaa',
  'taba',
  'maŋa',
  'bo',
  'maa',
  'din',
  'sheli',
  'pam',
  'nye',
  'nyela',
  'nima',
  'bahi',
  'yeli',
  'sani',
  'nyin',
  'so',
  'shin',
  'gba',
  'nti',
  'ŋun',
  'tooi',
  'pahi',
  'lana',
  'mini',
  'puni',
  'zaa',
  'kam',
  'ban',
])

const OPEN_E_LOOKALIKES = /[εԑ]/g
const DAGBANI_OPEN_E = 'ɛ'

function normalize(token: string): string {
  return token.replace(OPEN_E_LOOKALIKES, DAGBANI_OPEN_E)
}

/**
 * Dagbani analysis: the stop word list and the rules that split Dagbani
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `dagbani`.
 *
 * @public
 */
export const dagbani: LanguageModule = {
  name: 'dagbani',
  revision: '1',
  stemmer: null,
  stopWords: withNormalisedSpellings(stopWords, normalize),
  normalizer: normalize,
  tokenizer: {
    splitPattern: /[^a-zA-ZɛɔƐƆŋŊɣƔʒƷʊƱəƏεԑ0-9\p{M}]+/giu,
    normalizeDiacritics: false,
    minTokenLength: 1,
  },
}
