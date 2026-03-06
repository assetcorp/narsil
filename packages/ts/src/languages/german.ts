import type { LanguageModule } from '../types/language'

const VOWELS = 'aeiouyäöü'

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch)
}

function findRegions(word: string): { r1: number; r2: number } {
  let r1 = word.length
  let r2 = word.length

  let i = 1
  while (i < word.length) {
    if (!isVowel(word[i]) && isVowel(word[i - 1])) {
      r1 = i + 1
      break
    }
    i++
  }

  if (r1 < 3) r1 = 3

  i = r1
  while (i < word.length) {
    if (!isVowel(word[i]) && i > 0 && isVowel(word[i - 1])) {
      r2 = i + 1
      break
    }
    i++
  }

  return { r1, r2 }
}

function markConsonantUY(word: string): string {
  const chars = word.split('')
  for (let i = 1; i < chars.length - 1; i++) {
    if (chars[i] === 'u' && isVowel(chars[i - 1]) && isVowel(chars[i + 1])) {
      chars[i] = 'U'
    }
    if (chars[i] === 'y' && isVowel(chars[i - 1]) && isVowel(chars[i + 1])) {
      chars[i] = 'Y'
    }
  }
  return chars.join('')
}

const S_ENDING_VALID = 'bdfghklmnrt'

function isValidSEnding(word: string, beforeSuffix: number): boolean {
  if (beforeSuffix <= 0) return false
  return S_ENDING_VALID.includes(word[beforeSuffix - 1])
}

const ST_ENDING_VALID = 'bdfghklmnt'

const STEP1_SUFFIXES = ['em', 'ern', 'er', 'en', 'es', 'e', 's'] as const
const STEP2_SUFFIXES = ['est', 'en', 'er', 'st'] as const

const RE_ESZETT = /ß/g
const RE_UPPER_Y = /Y/g
const RE_UPPER_U = /U/g
const RE_UMLAUT_A = /ä/g
const RE_UMLAUT_O = /ö/g
const RE_UMLAUT_U = /ü/g

function isValidStEnding(word: string, beforeSuffix: number): boolean {
  if (beforeSuffix <= 0) return false
  return ST_ENDING_VALID.includes(word[beforeSuffix - 1])
}

function step1(word: string, r1: number): string {
  for (const suffix of STEP1_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= r1) {
      if (suffix === 's') {
        const cutPos = word.length - 1
        if (isValidSEnding(word, cutPos)) {
          return word.slice(0, cutPos)
        }
        return word
      }

      const stripped = word.slice(0, word.length - suffix.length)

      if (suffix === 'en' || suffix === 'e' || suffix === 'es') {
        if (stripped.endsWith('niss')) {
          return stripped.slice(0, -1)
        }
      }

      return stripped
    }
  }

  return word
}

function step2(word: string, r1: number): string {
  for (const suffix of STEP2_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= r1) {
      if (suffix === 'st') {
        const cutPos = word.length - 2
        if (cutPos >= 3 && isValidStEnding(word, cutPos)) {
          return word.slice(0, cutPos)
        }
        return word
      }

      return word.slice(0, word.length - suffix.length)
    }
  }

  return word
}

function step3(word: string, r1: number, r2: number): string {
  if (word.endsWith('keit') && word.length - 4 >= r2) {
    word = word.slice(0, -4)
    if (word.endsWith('lich') && word.length - 4 >= r2) {
      return word.slice(0, -4)
    }
    if (word.endsWith('ig') && word.length - 2 >= r2) {
      return word.slice(0, -2)
    }
    return word
  }

  if (word.endsWith('heit') && word.length - 4 >= r2) {
    word = word.slice(0, -4)
    if (word.endsWith('er') && word.length - 2 >= r1) {
      return word.slice(0, -2)
    }
    if (word.endsWith('en') && word.length - 2 >= r1) {
      return word.slice(0, -2)
    }
    return word
  }

  if (word.endsWith('isch') && word.length - 4 >= r2) {
    if (!word.endsWith('eisch')) {
      return word.slice(0, -4)
    }
    return word
  }

  if (word.endsWith('lich') && word.length - 4 >= r2) {
    word = word.slice(0, -4)
    if (word.endsWith('er') && word.length - 2 >= r1) {
      return word.slice(0, -2)
    }
    if (word.endsWith('en') && word.length - 2 >= r1) {
      return word.slice(0, -2)
    }
    return word
  }

  if (word.endsWith('end') && word.length - 3 >= r2) {
    word = word.slice(0, -3)
    if (word.endsWith('ig') && word.length - 2 >= r2 && !word.endsWith('eig')) {
      return word.slice(0, -2)
    }
    return word
  }

  if (word.endsWith('ung') && word.length - 3 >= r2) {
    word = word.slice(0, -3)
    if (word.endsWith('ig') && word.length - 2 >= r2 && !word.endsWith('eig')) {
      return word.slice(0, -2)
    }
    return word
  }

  if (word.endsWith('ig') && word.length - 2 >= r2) {
    if (!word.endsWith('eig')) {
      return word.slice(0, -2)
    }
    return word
  }

  if (word.endsWith('ik') && word.length - 2 >= r2) {
    if (!word.endsWith('eik')) {
      return word.slice(0, -2)
    }
    return word
  }

  return word
}

function restoreLowercase(word: string): string {
  return word
    .replace(RE_UPPER_Y, 'y')
    .replace(RE_UPPER_U, 'u')
    .replace(RE_UMLAUT_A, 'a')
    .replace(RE_UMLAUT_O, 'o')
    .replace(RE_UMLAUT_U, 'u')
}

function stem(word: string): string {
  if (word.length < 3) return word

  word = word.toLowerCase()
  word = word.replace(RE_ESZETT, 'ss')
  word = markConsonantUY(word)

  const { r1, r2 } = findRegions(word)

  word = step1(word, r1)
  word = step2(word, r1)
  word = step3(word, r1, r2)
  word = restoreLowercase(word)

  return word
}

const stopWords = new Set([
  'aber',
  'alle',
  'allem',
  'allen',
  'aller',
  'alles',
  'als',
  'also',
  'am',
  'an',
  'ander',
  'andere',
  'anderem',
  'anderen',
  'anderer',
  'anderes',
  'anderm',
  'andern',
  'anderr',
  'anders',
  'auch',
  'auf',
  'aus',
  'bei',
  'bin',
  'bis',
  'bist',
  'da',
  'damit',
  'dann',
  'der',
  'den',
  'des',
  'dem',
  'die',
  'das',
  'daß',
  'derselbe',
  'derselben',
  'denselben',
  'desselben',
  'demselben',
  'dieselbe',
  'dieselben',
  'dasselbe',
  'dazu',
  'dein',
  'deine',
  'deinem',
  'deinen',
  'deiner',
  'deines',
  'denn',
  'derer',
  'dessen',
  'dich',
  'dir',
  'du',
  'dies',
  'diese',
  'diesem',
  'diesen',
  'dieser',
  'dieses',
  'doch',
  'dort',
  'durch',
  'ein',
  'eine',
  'einem',
  'einen',
  'einer',
  'eines',
  'einig',
  'einige',
  'einigem',
  'einigen',
  'einiger',
  'einiges',
  'einmal',
  'er',
  'ihn',
  'ihm',
  'es',
  'etwas',
  'euer',
  'eure',
  'eurem',
  'euren',
  'eurer',
  'eures',
  'für',
  'gegen',
  'gewesen',
  'hab',
  'habe',
  'haben',
  'hat',
  'hatte',
  'hatten',
  'hier',
  'hin',
  'hinter',
  'ich',
  'mich',
  'mir',
  'ihr',
  'ihre',
  'ihrem',
  'ihren',
  'ihrer',
  'ihres',
  'euch',
  'im',
  'in',
  'indem',
  'ins',
  'ist',
  'jede',
  'jedem',
  'jeden',
  'jeder',
  'jedes',
  'jene',
  'jenem',
  'jenen',
  'jener',
  'jenes',
  'jetzt',
  'kann',
  'kein',
  'keine',
  'keinem',
  'keinen',
  'keiner',
  'keines',
  'können',
  'könnte',
  'machen',
  'man',
  'manche',
  'manchem',
  'manchen',
  'mancher',
  'manches',
  'mein',
  'meine',
  'meinem',
  'meinen',
  'meiner',
  'meines',
  'mit',
  'muss',
  'musste',
  'nach',
  'nicht',
  'nichts',
  'noch',
  'nun',
  'nur',
  'ob',
  'oder',
  'ohne',
  'sehr',
  'sein',
  'seine',
  'seinem',
  'seinen',
  'seiner',
  'seines',
  'selbst',
  'sich',
  'sie',
  'ihnen',
  'sind',
  'so',
  'solche',
  'solchem',
  'solchen',
  'solcher',
  'solches',
  'soll',
  'sollte',
  'sondern',
  'sonst',
  'über',
  'um',
  'und',
  'uns',
  'unse',
  'unsem',
  'unsen',
  'unser',
  'unses',
  'unter',
  'viel',
  'vom',
  'von',
  'vor',
  'während',
  'war',
  'waren',
  'warst',
  'was',
  'weg',
  'weil',
  'weiter',
  'welche',
  'welchem',
  'welchen',
  'welcher',
  'welches',
  'wenn',
  'werde',
  'werden',
  'wie',
  'wieder',
  'will',
  'wir',
  'wird',
  'wirst',
  'wo',
  'wollen',
  'wollte',
  'würde',
  'würden',
  'zu',
  'zum',
  'zur',
  'zwar',
  'zwischen',
])

export const german: LanguageModule = {
  name: 'german',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9äöüß]+/gi },
}
