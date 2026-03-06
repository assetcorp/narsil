import type { LanguageModule } from '../types/language'

const VOWELS = 'aeiouyäåö'

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

const S_ENDINGS = 'bcdfghjklmnoprtvy'

const STEP1_SUFFIXES = [
  'heterna',
  'hetens',
  'arnas',
  'ernas',
  'ornas',
  'anden',
  'heten',
  'heter',
  'andes',
  'arens',
  'andet',
  'arna',
  'erna',
  'orna',
  'ande',
  'arne',
  'aste',
  'aren',
  'ades',
  'erns',
  'ade',
  'are',
  'ern',
  'ens',
  'het',
  'ast',
  'ad',
  'en',
  'ar',
  'er',
  'or',
  'as',
  'es',
  'at',
  'a',
  'e',
  's',
]

function step1(word: string, r1: number): string {
  for (const suffix of STEP1_SUFFIXES) {
    if (!word.endsWith(suffix)) continue
    const boundary = word.length - suffix.length
    if (boundary < r1) continue

    if (suffix === 's') {
      if (boundary > 0 && S_ENDINGS.includes(word[boundary - 1])) {
        return word.slice(0, boundary)
      }
      continue
    }

    return word.slice(0, boundary)
  }
  return word
}

const STEP2_ENDINGS = ['dd', 'gd', 'nn', 'dt', 'gt', 'kt', 'tt']

function step2(word: string, r1: number): string {
  for (const ending of STEP2_ENDINGS) {
    if (!word.endsWith(ending)) continue
    if (word.length - 2 < r1) continue
    return word.slice(0, -1)
  }
  return word
}

const STEP3_SUFFIXES: Array<[string, string | null]> = [
  ['fullt', 'full'],
  ['löst', 'lös'],
  ['lig', null],
  ['els', null],
  ['ig', null],
]

function step3(word: string, r1: number): string {
  for (const [suffix, replacement] of STEP3_SUFFIXES) {
    if (!word.endsWith(suffix)) continue
    const boundary = word.length - suffix.length
    if (boundary < r1) continue
    return replacement ? word.slice(0, boundary) + replacement : word.slice(0, boundary)
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
  'och',
  'det',
  'att',
  'i',
  'en',
  'jag',
  'hon',
  'som',
  'han',
  'på',
  'den',
  'med',
  'var',
  'sig',
  'för',
  'så',
  'till',
  'är',
  'men',
  'ett',
  'om',
  'hade',
  'de',
  'av',
  'icke',
  'mig',
  'du',
  'henne',
  'då',
  'sin',
  'nu',
  'har',
  'inte',
  'hans',
  'honom',
  'skulle',
  'hennes',
  'där',
  'min',
  'man',
  'ej',
  'vid',
  'kunde',
  'något',
  'från',
  'ut',
  'när',
  'efter',
  'upp',
  'vi',
  'dem',
  'vara',
  'vad',
  'över',
  'än',
  'dig',
  'kan',
  'sina',
  'här',
  'ha',
  'mot',
  'alla',
  'under',
  'någon',
  'eller',
  'allt',
  'mycket',
  'sedan',
  'ju',
  'denna',
  'själv',
  'detta',
  'åt',
  'utan',
  'varit',
  'hur',
  'ingen',
  'mitt',
  'ni',
  'bli',
  'blev',
  'oss',
  'din',
  'dessa',
  'några',
  'deras',
  'blir',
  'mina',
  'samma',
  'vilken',
  'er',
  'sådan',
  'vår',
  'blivit',
  'dess',
  'inom',
  'mellan',
  'sådant',
  'varför',
  'varje',
  'vilka',
  'ditt',
  'vem',
  'vilket',
  'sitta',
  'sådana',
  'vart',
  'dina',
  'vars',
  'vårt',
  'våra',
  'ert',
  'era',
  'vilkas',
])

export const swedish: LanguageModule = {
  name: 'swedish',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9åäöü-]+/gi },
}
