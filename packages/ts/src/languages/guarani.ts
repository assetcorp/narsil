/*
 * Stop words sourced from:
 *   - Grammatical function words, pronouns, postpositions, and particles
 *     curated for Narsil
 *   - A word holding the puso is listed twice, once spelled with U+0027 and once
 *     with the saltillo U+A78C, because Guarani Wikipedia writes both and stop
 *     word removal runs before the normalizer folds them together
 */

import type { LanguageModule } from '../types/language'
import { withNormalisedSpellings } from './support/spellings'

const PUSO = "'"
const SALTILLO = '\u{a78c}'
const SALTILLO_PATTERN = /\u{a78c}/gu

function bothPusoSpellings(words: readonly string[]): string[] {
  return words.flatMap(word => (word.includes(PUSO) ? [word, word.split(PUSO).join(SALTILLO)] : [word]))
}

const stopWords = new Set(
  bothPusoSpellings([
    'aja',
    'akue',
    'ambue',
    'ambuéva',
    'amo',
    'ani',
    'apytépe',
    "araka'e",
    'ári',
    'avave',
    'ave',
    'avei',
    'che',
    'chéve',
    'chugui',
    'chupe',
    'gotyo',
    'gui',
    'guive',
    'guýpe',
    'ha',
    "ha'e",
    "ha'ekuéra",
    "ha'éva",
    'hag̃ua',
    'hákatu',
    'heẽ',
    'hendive',
    'hese',
    'heta',
    'hikuái',
    'hína',
    'ína',
    'jare',
    'jave',
    'jepe',
    'katu',
    'ko',
    "ko'ã",
    "ko'ág̃a",
    "ko'ãga",
    "ko'ápe",
    "ko'ãva",
    'kóva',
    'ku',
    'kuéra',
    'kuri',
    'máva',
    'mávapa',
    'mayma',
    'maymáva',
    "mba'e",
    "mba'éicha",
    "mba'éichapa",
    "mba'ére",
    'mbovy',
    'mboy',
    'mboyve',
    'mbytépe',
    'me',
    'moõ',
    'nahániri',
    'ñande',
    'ñane',
    'ndaje',
    'nde',
    'ndéve',
    'ndive',
    'ne',
    'nguéra',
    'niko',
    'nko',
    'oñondive',
    'opa',
    'opaite',
    'ore',
    'pe',
    'peẽ',
    'pegua',
    'péicha',
    'pende',
    'peteĩ',
    'péva',
    'peve',
    'piko',
    'ramo',
    'rehe',
    'rehegua',
    'reta',
    'reve',
    'rire',
    'rupi',
    'rupive',
    'térã',
    'umi',
    'umíva',
    'upe',
    'upéi',
    'upéicha',
    'upépe',
    'upérõ',
    'upéva',
    'upévare',
    "va'ekue",
    "va'erã",
    'voi',
  ]),
)

function normalize(token: string): string {
  return token.replace(SALTILLO_PATTERN, PUSO)
}

export const guarani: LanguageModule = {
  name: 'guarani',
  stemmer: null,
  stopWords: withNormalisedSpellings(stopWords, normalize),
  normalizer: normalize,
  tokenizer: { splitPattern: /[^\p{Script=Latin}\p{M}0-9']+/giu },
}
