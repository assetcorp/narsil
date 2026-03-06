import type { LanguageModule } from '../types/language'

const SUBJECT_PREFIXES = ['ni', 'tu', 'wa', 'vi', 'zi', 'li', 'ya', 'ku']
const SHORT_SUBJECT_PREFIXES = ['u', 'a', 'i', 'm']
const TENSE_MARKERS = ['na', 'li', 'ta', 'me', 'ki']
const RELATIVE_MARKERS = ['ye', 'cho', 'vyo', 'zo', 'lo', 'yo', 'ko', 'po', 'mo']
const NEGATIVE_PREFIXES = ['ha', 'si']
const NOUN_CLASS_PREFIXES = ['wa', 'mi', 'ki', 'vi', 'ma']
const SHORT_NOUN_PREFIXES = ['m', 'u']

const LONG_SUFFIXES = ['isha', 'ika', 'ana', 'iwa', 'ewa', 'aje', 'ane', 'eni', 'ini']
const SHORT_SUFFIXES = ['wa', 'ia', 'ea']
const FINAL_VOWELS = ['a', 'i', 'e', 'u']

function tryRemovePrefix(word: string, prefix: string, minRemaining: number): string | null {
  if (word.startsWith(prefix) && word.length - prefix.length >= minRemaining) {
    return word.slice(prefix.length)
  }
  return null
}

function removePrefixes(word: string): string {
  let current = word

  for (const prefix of NEGATIVE_PREFIXES) {
    const result = tryRemovePrefix(current, prefix, 3)
    if (result !== null) {
      current = result
      break
    }
  }

  let subjectRemoved = false
  for (const prefix of SUBJECT_PREFIXES) {
    const result = tryRemovePrefix(current, prefix, 3)
    if (result !== null) {
      current = result
      subjectRemoved = true
      break
    }
  }
  if (!subjectRemoved) {
    for (const prefix of SHORT_SUBJECT_PREFIXES) {
      const result = tryRemovePrefix(current, prefix, 3)
      if (result !== null) {
        current = result
        subjectRemoved = true
        break
      }
    }
  }

  if (subjectRemoved) {
    for (const marker of TENSE_MARKERS) {
      const result = tryRemovePrefix(current, marker, 3)
      if (result !== null) {
        current = result
        break
      }
    }

    for (const marker of RELATIVE_MARKERS) {
      const result = tryRemovePrefix(current, marker, 3)
      if (result !== null) {
        current = result
        break
      }
    }
  }

  if (!subjectRemoved) {
    for (const prefix of NOUN_CLASS_PREFIXES) {
      const result = tryRemovePrefix(current, prefix, 3)
      if (result !== null) {
        current = result
        break
      }
    }
    if (current === word) {
      for (const prefix of SHORT_NOUN_PREFIXES) {
        const result = tryRemovePrefix(current, prefix, 3)
        if (result !== null) {
          current = result
          break
        }
      }
    }
  }

  return current
}

function removeSuffixes(word: string): string {
  for (const suffix of LONG_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length)
    }
  }

  for (const suffix of SHORT_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length)
    }
  }

  for (const vowel of FINAL_VOWELS) {
    if (word.endsWith(vowel) && word.length - 1 >= 3) {
      return word.slice(0, -1)
    }
  }

  return word
}

function stem(word: string): string {
  if (word.length < 4) return word
  let result = removePrefixes(word)
  result = removeSuffixes(result)
  return result
}

const stopWords = new Set([
  'wa',
  'na',
  'ya',
  'kwa',
  'la',
  'za',
  'ni',
  'au',
  'katika',
  'kama',
  'lakini',
  'pia',
  'hii',
  'yake',
  'wake',
  'yangu',
  'yetu',
  'yao',
  'ile',
  'hizo',
  'hiyo',
  'hivi',
  'hivyo',
  'huku',
  'kila',
  'bila',
  'ama',
  'bali',
  'hata',
  'ingawa',
  'kwamba',
  'kuwa',
  'ili',
  'mpaka',
  'tangu',
  'ndiyo',
  'hapana',
  'hapa',
  'pale',
  'sana',
  'tu',
  'hasa',
  'kabisa',
  'ndio',
  'nini',
  'gani',
  'wapi',
  'lini',
  'vipi',
  'nani',
  'kwani',
  'basi',
  'sasa',
  'tena',
  'bado',
  'tayari',
  'labda',
  'pengine',
  'yote',
  'wote',
  'zote',
  'kote',
  'nyingi',
  'mengi',
  'wengi',
  'chache',
  'kidogo',
  'zaidi',
  'sawa',
  'kweli',
  'si',
  'siyo',
  'hakuna',
  'wala',
  'halafu',
  'kisha',
  'baada',
  'kabla',
  'wakati',
  'mara',
  'daima',
  'kamwe',
  'ikiwa',
  'iwapo',
  'endapo',
  'ijapokuwa',
  'kutoka',
  'hadi',
  'kuhusu',
  'juu',
  'chini',
  'ndani',
  'nje',
  'mbele',
  'nyuma',
  'karibu',
  'mbali',
])

export const swahili: LanguageModule = {
  name: 'swahili',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9]+/gi },
}
