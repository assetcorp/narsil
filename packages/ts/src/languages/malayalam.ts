/*
 * Stop words sourced from:
 *   - spaCy Malayalam stop words (https://github.com/explosion/spaCy), MIT
 *   - Curated function-word additions for Narsil
 */

import type { LanguageModule } from '../types/language'
import { withNormalisedSpellings } from './support/spellings'

const stopWords = new Set([
  'അങ്ങനെ',
  'അതിനാൽ',
  'അതിന്',
  'അതിന്റെ',
  'അതിൽ',
  'അതും',
  'അതുകൊണ്ട്',
  'അത്',
  'അന്നേരം',
  'അന്ന്',
  'അപ്പോൾ',
  'അല്ല',
  'അല്ലെങ്കിൽ',
  'അവൻ',
  'അവന്റെ',
  'അവരുടെ',
  'അവർ',
  'അവളുടെ',
  'അവൾ',
  'അവിടെ',
  'ആ',
  'ആകും',
  'ആകുന്നു',
  'ആണ്',
  'ആയ',
  'ആയി',
  'ആയിരുന്നു',
  'ആര്',
  'ഇങ്ങനെ',
  'ഇതിന്',
  'ഇതിന്റെ',
  'ഇതിൽ',
  'ഇതും',
  'ഇത്',
  'ഇനി',
  'ഇന്ന്',
  'ഇപ്പോൾ',
  'ഇല്ല',
  'ഇവർ',
  'ഇവിടെ',
  'ഈ',
  'ഉണ്ട്',
  'ഉള്ള',
  'എങ്കിലും',
  'എങ്കിൽ',
  'എങ്ങനെ',
  'എന്ത്',
  'എന്ന',
  'എന്നാൽ',
  'എന്നിവ',
  'എന്നു',
  'എന്നും',
  'എന്ന്',
  'എന്റെ',
  'എപ്പോൾ',
  'എല്ലാ',
  'എവിടെ',
  'ഏത്',
  'ഏറ്റവും',
  'ഒപ്പം',
  'ഒരു',
  'ഓരോ',
  'കഴിയും',
  'കൂടാതെ',
  'കൂടി',
  'കൂടെ',
  'ചില',
  'ഞങ്ങൾ',
  'ഞാൻ',
  'തന്നെ',
  'തന്റെ',
  'താൻ',
  'നമ്മുടെ',
  'നാം',
  'നിങ്ങൾ',
  'നിന്റെ',
  'നീ',
  'പക്ഷേ',
  'പല',
  'പിന്നെ',
  'പോലും',
  'പോലെ',
  'മറ്റു',
  'മറ്റ്',
  'മാത്രം',
  'മുതൽ',
  'വരെ',
  'വളരെ',
  'വേണം',
  'വേണ്ടി',
  'ശേഷം',
])

const CHILLU_BY_BASE = new Map([
  ['\u0D23', '\u0D7A'],
  ['\u0D28', '\u0D7B'],
  ['\u0D30', '\u0D7C'],
  ['\u0D32', '\u0D7D'],
  ['\u0D33', '\u0D7E'],
  ['\u0D15', '\u0D7F'],
])
const JOINED_CHILLU = /([\u0D23\u0D28\u0D30\u0D32\u0D33\u0D15])\u0D4D\u200D/g
const ZERO_WIDTH_JOINERS = /[\u200c\u200d]/g

function foldChillu(_match: string, base: string): string {
  return CHILLU_BY_BASE.get(base) ?? base
}

function normalize(token: string): string {
  return token.replace(JOINED_CHILLU, foldChillu).replace(ZERO_WIDTH_JOINERS, '')
}

/**
 * Malayalam analysis: the stop word list and the rules that split Malayalam
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `malayalam`.
 *
 * @public
 */
export const malayalam: LanguageModule = {
  name: 'malayalam',
  revision: '1',
  stemmer: null,
  stopWords: withNormalisedSpellings(stopWords, normalize),
  normalizer: normalize,
  tokenizer: { splitPattern: /[^\u0d00-\u0d7f\u200c\u200da-z0-9]+/gi },
}
