import type { LanguageModule } from '../types/language'

const VOWELS = 'aeiouyåæø'

const S_ENDINGS = 'abcdfghjklmnoprtvyzå'

const STEP1_SUFFIXES = [
  'erendes',
  'hedens',
  'erende',
  'erens',
  'endes',
  'ernes',
  'enes',
  'eres',
  'erets',
  'heder',
  'ethed',
  'erede',
  'heden',
  'ered',
  'erer',
  'ende',
  'erne',
  'ene',
  'ere',
  'eren',
  'heds',
  'eret',
  'ens',
  'ers',
  'ets',
  'hed',
  'en',
  'er',
  'es',
  'et',
  'e',
]

const UNDOUBLE_PAIRS = ['gd', 'dt', 'gt', 'kt']

const STEP3_SUFFIXES: Array<{ text: string; replacement: string | null }> = [
  { text: 'elig', replacement: null },
  { text: 'løst', replacement: 'løs' },
  { text: 'lig', replacement: null },
  { text: 'els', replacement: null },
  { text: 'ig', replacement: null },
]

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch)
}

function isConsonant(ch: string): boolean {
  return ch.length === 1 && !isVowel(ch)
}

/**
 * Compute the R1 region: the substring after the first consonant
 * that follows a vowel, with a minimum start position of 3.
 */
function computeR1(word: string): number {
  let foundVowel = false
  for (let i = 0; i < word.length; i++) {
    if (foundVowel && !isVowel(word[i])) {
      return Math.max(i + 1, 3)
    }
    if (isVowel(word[i])) {
      foundVowel = true
    }
  }
  return word.length
}

function step1(word: string, r1: number): string {
  for (const suffix of STEP1_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= r1) {
      return word.slice(0, -suffix.length)
    }
  }

  if (word.endsWith('s') && word.length - 1 >= r1) {
    const preceding = word[word.length - 2]
    if (preceding && S_ENDINGS.includes(preceding)) {
      return word.slice(0, -1)
    }
  }

  return word
}

/**
 * Undouble specific consonant pairs: gd, dt, gt, kt.
 * If the word ends in one of these pairs, remove the last letter.
 */
function undouble(word: string, r1: number): string {
  if (word.length < r1) return word

  for (const pair of UNDOUBLE_PAIRS) {
    if (word.endsWith(pair)) {
      return word.slice(0, -1)
    }
  }

  return word
}

function step3(word: string, r1: number): string {
  if (word.endsWith('igst')) {
    word = word.slice(0, -2)
  }

  for (const { text, replacement } of STEP3_SUFFIXES) {
    if (word.endsWith(text) && word.length - text.length >= r1) {
      if (replacement !== null) {
        return word.slice(0, -text.length) + replacement
      }
      word = word.slice(0, -text.length)
      word = undouble(word, r1)
      return word
    }
  }

  return word
}

/**
 * If the word ends in a repeated consonant, remove the final letter.
 */
function step4(word: string, r1: number): string {
  if (word.length < 2 || word.length <= r1) return word

  const last = word[word.length - 1]
  const secondLast = word[word.length - 2]
  if (isConsonant(last) && last === secondLast) {
    return word.slice(0, -1)
  }

  return word
}

function stem(word: string): string {
  if (word.length < 3) return word

  word = word.toLowerCase()
  const r1 = computeR1(word)

  word = step1(word, r1)
  word = undouble(word, r1)
  word = step3(word, r1)
  word = step4(word, r1)

  return word
}

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

export const danish: LanguageModule = {
  name: 'danish',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9æøå]+/gi },
}
