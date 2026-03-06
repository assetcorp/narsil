import type { LanguageModule } from '../types/language'

const VOWELS = 'aeiouyåæø'

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch)
}

/**
 * R1 is the region after the first consonant following a vowel,
 * clamped to a minimum of position 3.
 */
function computeR1(word: string): number {
  let i = 0
  while (i < word.length && !isVowel(word[i])) i++
  while (i < word.length && isVowel(word[i])) i++

  const r1 = i < word.length ? i + 1 : word.length
  return Math.max(r1, 3)
}

const S_ENDINGS = 'bcdfghjlmnoprtvyz'

const STEP1_SUFFIXES = [
  'hetenes',
  'hetene',
  'hetens',
  'endes',
  'heten',
  'heter',
  'ande',
  'ende',
  'edes',
  'enes',
  'erte',
  'ane',
  'ene',
  'ens',
  'ers',
  'ets',
  'ede',
  'het',
  'en',
  'ar',
  'er',
  'et',
  'as',
  'es',
  'ert',
  'ast',
  'a',
  'e',
  's',
]

function step1(word: string, r1: number): string {
  for (const suffix of STEP1_SUFFIXES) {
    if (!word.endsWith(suffix)) continue
    const boundary = word.length - suffix.length
    if (boundary < r1) continue

    if (suffix === 'erte' || suffix === 'ert') {
      return `${word.slice(0, boundary)}er`
    }

    if (suffix === 's') {
      if (boundary > 0) {
        const preceding = word[boundary - 1]
        if (S_ENDINGS.includes(preceding)) return word.slice(0, boundary)
        if (preceding === 'k' && boundary > 1 && !isVowel(word[boundary - 2])) {
          return word.slice(0, boundary)
        }
      }
      continue
    }

    return word.slice(0, boundary)
  }
  return word
}

function step2(word: string, r1: number): string {
  if (word.length < 2) return word
  const last2 = word.slice(-2)
  if ((last2 === 'dt' || last2 === 'vt') && word.length - 2 >= r1) {
    return word.slice(0, -1)
  }
  return word
}

const STEP3_SUFFIXES = ['hetslov', 'elov', 'slov', 'elig', 'eleg', 'lig', 'eig', 'leg', 'lov', 'els', 'ig']

function step3(word: string, r1: number): string {
  for (const suffix of STEP3_SUFFIXES) {
    if (!word.endsWith(suffix)) continue
    if (word.length - suffix.length >= r1) {
      return word.slice(0, word.length - suffix.length)
    }
  }
  return word
}

function stem(word: string): string {
  if (word.length < 3) return word

  const r1 = computeR1(word)

  word = step1(word, r1)
  word = step2(word, r1)
  word = step3(word, r1)

  return word
}

const stopWords = new Set([
  'og',
  'i',
  'jeg',
  'det',
  'at',
  'en',
  'et',
  'den',
  'til',
  'er',
  'som',
  'på',
  'de',
  'med',
  'han',
  'av',
  'ikke',
  'ikkje',
  'der',
  'så',
  'var',
  'meg',
  'seg',
  'men',
  'ett',
  'har',
  'om',
  'vi',
  'min',
  'mitt',
  'ha',
  'hadde',
  'hun',
  'nå',
  'over',
  'da',
  'ved',
  'fra',
  'du',
  'ut',
  'sin',
  'dem',
  'oss',
  'opp',
  'man',
  'kan',
  'hans',
  'hvor',
  'eller',
  'hva',
  'skal',
  'selv',
  'sjøl',
  'her',
  'alle',
  'vil',
  'bli',
  'ble',
  'blei',
  'blitt',
  'kunne',
  'inn',
  'når',
  'være',
  'kom',
  'noen',
  'noe',
  'ville',
  'dere',
  'deres',
  'kun',
  'ja',
  'etter',
  'ned',
  'skulle',
  'denne',
  'for',
  'deg',
  'si',
  'sine',
  'sitt',
  'mot',
  'å',
  'meget',
  'hvorfor',
  'dette',
  'disse',
  'uten',
  'hvordan',
  'ingen',
  'din',
  'ditt',
  'blir',
  'samme',
  'hvilken',
  'hvilke',
  'sånn',
  'inni',
  'mellom',
  'vår',
  'hver',
  'hvem',
  'vors',
  'hvis',
  'både',
  'bare',
  'enn',
  'fordi',
  'før',
  'mange',
  'også',
  'slik',
  'vært',
  'båe',
  'begge',
  'siden',
  'dykk',
  'dykkar',
  'dei',
  'deira',
  'deires',
  'deim',
  'di',
  'då',
  'eg',
  'ein',
  'eit',
  'eitt',
  'elles',
  'honom',
  'hjå',
  'ho',
  'hoe',
  'henne',
  'hennar',
  'hennes',
  'hoss',
  'hossen',
  'ingi',
  'inkje',
  'korleis',
  'korso',
  'kva',
  'kvar',
  'kvarhelst',
  'kven',
  'kvi',
  'kvifor',
  'me',
  'medan',
  'mi',
  'mine',
  'mykje',
  'no',
  'nokon',
  'noka',
  'nokor',
  'noko',
  'nokre',
  'sia',
  'sidan',
  'so',
  'somt',
  'somme',
  'um',
  'upp',
  'vere',
  'vore',
  'verte',
  'vort',
  'varte',
  'vart',
])

export const norwegian: LanguageModule = {
  name: 'norwegian',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9æøåäöü]+/gi },
}
