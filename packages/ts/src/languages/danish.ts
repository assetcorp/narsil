/*
 * Stop words sourced from:
 *   - Snowball stop word list (https://snowballstem.org/), BSD-3-Clause
 *
 * The stemmer is generated from Snowball's algorithms/danish.sbl; see snowball/build.ts.
 */

import type { LanguageModule } from '../types/language'
import { stem } from './snowball/danish'
import { removeMarks } from './support/marks'
import { withNormalisedSpellings } from './support/spellings'

const stopWords = new Set([
  'og',
  'i',
  'jeg',
  'det',
  'at',
  'en',
  'den',
  'til',
  'er',
  'som',
  'på',
  'de',
  'med',
  'han',
  'af',
  'for',
  'ikke',
  'der',
  'var',
  'mig',
  'sig',
  'men',
  'et',
  'har',
  'om',
  'vi',
  'min',
  'havde',
  'ham',
  'hun',
  'nu',
  'over',
  'da',
  'fra',
  'du',
  'ud',
  'sin',
  'dem',
  'os',
  'op',
  'man',
  'hans',
  'hvor',
  'eller',
  'hvad',
  'skal',
  'selv',
  'her',
  'alle',
  'vil',
  'blev',
  'kunne',
  'ind',
  'når',
  'være',
  'dog',
  'noget',
  'ville',
  'jo',
  'deres',
  'efter',
  'ned',
  'skulle',
  'denne',
  'end',
  'dette',
  'mit',
  'også',
  'under',
  'have',
  'dig',
  'anden',
  'hende',
  'mine',
  'alt',
  'meget',
  'sit',
  'sine',
  'vor',
  'mod',
  'disse',
  'hvis',
  'din',
  'nogle',
  'hos',
  'blive',
  'mange',
  'ad',
  'bliver',
  'hendes',
  'været',
  'thi',
  'jer',
  'sådan',
])

const STRESS_ACCENT = /\u0301/g

function normalize(token: string): string {
  return removeMarks(token, STRESS_ACCENT)
}

/**
 * Danish analysis: the Snowball stemmer, the stop word list, and the rules
 * that split Danish text into tokens.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `danish`.
 *
 * @public
 */
export const danish: LanguageModule = {
  name: 'danish',
  revision: '4337c6ed283fa798',
  stemmer: stem,
  stopWords: withNormalisedSpellings(stopWords, normalize),
  normalizer: normalize,
  tokenizer: { splitPattern: /[^a-z0-9æøåé]+/gi },
}
