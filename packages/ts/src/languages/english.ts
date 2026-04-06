import type { LanguageModule } from '../types/language'

const SUFFIX_TRANSFORMS_STEP2: Record<string, string> = {
  ational: 'ate',
  tional: 'tion',
  enci: 'ence',
  anci: 'ance',
  izer: 'ize',
  bli: 'ble',
  alli: 'al',
  entli: 'ent',
  eli: 'e',
  ousli: 'ous',
  ization: 'ize',
  ation: 'ate',
  ator: 'ate',
  alism: 'al',
  iveness: 'ive',
  fulness: 'ful',
  ousness: 'ous',
  aliti: 'al',
  iviti: 'ive',
  biliti: 'ble',
  logi: 'log',
}

const SUFFIX_TRANSFORMS_STEP3: Record<string, string> = {
  icate: 'ic',
  ative: '',
  alize: 'al',
  iciti: 'ic',
  ical: 'ic',
  ful: '',
  ness: '',
}

const CONSONANT = '[^aeiou]'
const VOWEL = '[aeiouy]'
const CONSONANT_SEQ = `${CONSONANT}[^aeiouy]*`
const VOWEL_SEQ = `${VOWEL}[aeiou]*`

const RE_MEASURE_GT_0 = new RegExp(`^(${CONSONANT_SEQ})?${VOWEL_SEQ}${CONSONANT_SEQ}`)
const RE_MEASURE_EQ_1 = new RegExp(`^(${CONSONANT_SEQ})?${VOWEL_SEQ}${CONSONANT_SEQ}(${VOWEL_SEQ})?$`)
const RE_MEASURE_GT_1 = new RegExp(`^(${CONSONANT_SEQ})?${VOWEL_SEQ}${CONSONANT_SEQ}${VOWEL_SEQ}${CONSONANT_SEQ}`)
const RE_HAS_VOWEL = new RegExp(`^(${CONSONANT_SEQ})?${VOWEL}`)
const RE_CONSONANT_CVC = new RegExp(`^${CONSONANT_SEQ}${VOWEL}[^aeiouwxy]$`)

const RE_PLURAL_SS_IES = /^(.+?)(ss|i)es$/
const RE_PLURAL_S = /^(.+?)([^s])s$/
const RE_SUFFIX_EED = /^(.+?)eed$/
const RE_SUFFIX_ED_ING = /^(.+?)(ed|ing)$/
const RE_SUFFIX_AT_BL_IZ = /(at|bl|iz)$/
const RE_DOUBLE_CONSONANT = /([^aeiouylsz])\1$/
const RE_TRAILING_Y = /^(.+?)y$/
const RE_STEP2_SUFFIXES =
  /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/
const RE_STEP3_SUFFIXES = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/
const RE_STEP4_SUFFIXES = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/
const RE_STEP4_STION = /^(.+?)(s|t)(ion)$/
const RE_TRAILING_E = /^(.+?)e$/
const RE_TRAILING_LL = /ll$/

function hasMeasureGt0(stem: string): boolean {
  return RE_MEASURE_GT_0.test(stem)
}

function hasMeasureGt1(stem: string): boolean {
  return RE_MEASURE_GT_1.test(stem)
}

function stripPlurals(word: string): string {
  if (RE_PLURAL_SS_IES.test(word)) return word.slice(0, -2)
  if (RE_PLURAL_S.test(word)) return word.slice(0, -1)
  return word
}

function stripVerbSuffixes(word: string): string {
  let match = RE_SUFFIX_EED.exec(word)
  if (match) {
    return hasMeasureGt0(match[1]) ? word.slice(0, -1) : word
  }

  match = RE_SUFFIX_ED_ING.exec(word)
  if (match) {
    const base = match[1]
    if (!RE_HAS_VOWEL.test(base)) return word
    word = base
    if (RE_SUFFIX_AT_BL_IZ.test(word)) return `${word}e`
    if (RE_DOUBLE_CONSONANT.test(word)) return word.slice(0, -1)
    if (RE_CONSONANT_CVC.test(word)) return `${word}e`
  }

  return word
}

function replaceTrailingY(word: string): string {
  const match = RE_TRAILING_Y.exec(word)
  if (match && RE_HAS_VOWEL.test(match[1])) {
    return `${match[1]}i`
  }
  return word
}

function applySuffixMap(word: string, pattern: RegExp, map: Record<string, string>): string {
  const match = pattern.exec(word)
  if (match) {
    const base = match[1]
    const suffix = match[2]
    if (hasMeasureGt0(base)) {
      return base + map[suffix]
    }
  }
  return word
}

function stripDerivationals(word: string): string {
  let match = RE_STEP4_SUFFIXES.exec(word)
  if (match) {
    return hasMeasureGt1(match[1]) ? match[1] : word
  }

  match = RE_STEP4_STION.exec(word)
  if (match) {
    const base = match[1] + match[2]
    return hasMeasureGt1(base) ? base : word
  }

  return word
}

function tidyTrailingE(word: string): string {
  const match = RE_TRAILING_E.exec(word)
  if (match) {
    const base = match[1]
    if (hasMeasureGt1(base)) return base
    if (RE_MEASURE_EQ_1.test(base) && !RE_CONSONANT_CVC.test(base)) return base
  }
  return word
}

function collapseDoubleLl(word: string): string {
  if (RE_TRAILING_LL.test(word) && hasMeasureGt1(word)) {
    return word.slice(0, -1)
  }
  return word
}

function stemWord(input: string): string {
  if (input.length < 3) return input

  const startsWithY = input[0] === 'y'
  let word = startsWithY ? `Y${input.substring(1)}` : input

  word = stripPlurals(word)
  word = stripVerbSuffixes(word)
  word = replaceTrailingY(word)
  word = applySuffixMap(word, RE_STEP2_SUFFIXES, SUFFIX_TRANSFORMS_STEP2)
  word = applySuffixMap(word, RE_STEP3_SUFFIXES, SUFFIX_TRANSFORMS_STEP3)
  word = stripDerivationals(word)
  word = tidyTrailingE(word)
  word = collapseDoubleLl(word)

  if (startsWithY) {
    word = `y${word.substring(1)}`
  }

  return word
}

const stopWords = new Set([
  'a',
  'an',
  'the',
  'i',
  'me',
  'my',
  'myself',
  'we',
  'us',
  'our',
  'ours',
  'ourselves',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
  'he',
  'him',
  'his',
  'himself',
  'she',
  'her',
  'hers',
  'herself',
  'it',
  'its',
  'itself',
  'they',
  'them',
  'their',
  'theirs',
  'themselves',
  'what',
  'which',
  'who',
  'whom',
  'this',
  'that',
  'these',
  'those',
  'am',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'having',
  'do',
  'does',
  'did',
  'doing',
  'will',
  'would',
  'shall',
  'should',
  'can',
  'could',
  'may',
  'might',
  'must',
  'ought',
  "i'm",
  "you're",
  "he's",
  "she's",
  "it's",
  "we're",
  "they're",
  "i've",
  "you've",
  "we've",
  "they've",
  "i'd",
  "you'd",
  "he'd",
  "she'd",
  "we'd",
  "they'd",
  "i'll",
  "you'll",
  "he'll",
  "she'll",
  "we'll",
  "they'll",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "hasn't",
  "haven't",
  "hadn't",
  "doesn't",
  "don't",
  "didn't",
  "won't",
  "wouldn't",
  "shan't",
  "shouldn't",
  "can't",
  'cannot',
  "couldn't",
  "mustn't",
  "let's",
  "that's",
  "who's",
  "what's",
  "here's",
  "there's",
  "when's",
  "where's",
  "why's",
  "how's",
  'and',
  'but',
  'if',
  'or',
  'because',
  'as',
  'until',
  'while',
  'of',
  'at',
  'by',
  'for',
  'with',
  'about',
  'against',
  'between',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'to',
  'from',
  'up',
  'down',
  'in',
  'out',
  'on',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'all',
  'any',
  'both',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'nor',
  'not',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
])

export const english: LanguageModule = {
  name: 'english',
  stemmer: stemWord,
  stopWords,
}
