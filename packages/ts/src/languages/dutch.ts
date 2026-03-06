import type { LanguageModule } from '../types/language'

const VOWELS = 'aeiouyè'

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch)
}

function isVowelOrJ(ch: string): boolean {
  return VOWELS.includes(ch) || ch === 'j'
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

function markConsonantIY(word: string): string {
  const chars = word.split('')

  if (chars.length > 0 && chars[0] === 'y') {
    chars[0] = 'Y'
  }

  for (let i = 1; i < chars.length; i++) {
    if (chars[i] === 'y' && isVowel(chars[i - 1])) {
      chars[i] = 'Y'
    }
    if (chars[i] === 'i' && isVowel(chars[i - 1]) && i + 1 < chars.length && isVowel(chars[i + 1])) {
      chars[i] = 'I'
    }
  }

  return chars.join('')
}

function undouble(word: string): string {
  if (word.endsWith('kk') || word.endsWith('dd') || word.endsWith('tt')) {
    return word.slice(0, -1)
  }
  return word
}

function removeEnSuffix(word: string, r1: number): string {
  if (!word.endsWith('en')) return word
  if (word.length - 2 < r1) return word
  const beforeSuffix = word.length - 2
  if (beforeSuffix <= 0 || isVowel(word[beforeSuffix - 1])) return word
  const base = word.slice(0, -2)
  if (base.endsWith('gem')) return word
  return undouble(base)
}

function step1(word: string, r1: number): string {
  if (word.endsWith('heden') && word.length - 5 >= r1) {
    return `${word.slice(0, -5)}heid`
  }

  if (word.endsWith('ene') && word.length - 3 >= r1) {
    const beforeSuffix = word.length - 3
    if (beforeSuffix > 0 && !isVowel(word[beforeSuffix - 1])) {
      const base = word.slice(0, -3)
      if (!base.endsWith('gem')) {
        return undouble(base)
      }
    }
  }

  if (word.endsWith('en') && !word.endsWith('ene') && word.length - 2 >= r1) {
    const beforeSuffix = word.length - 2
    if (beforeSuffix > 0 && !isVowel(word[beforeSuffix - 1])) {
      const base = word.slice(0, -2)
      if (!base.endsWith('gem')) {
        return undouble(base)
      }
    }
  }

  if (word.endsWith('se') && word.length - 2 >= r1) {
    const beforeSuffix = word.length - 2
    if (beforeSuffix > 0 && !isVowelOrJ(word[beforeSuffix - 1])) {
      return word.slice(0, -2)
    }
  }

  if (word.endsWith('s') && !word.endsWith('se') && word.length - 1 >= r1) {
    const beforeSuffix = word.length - 1
    if (beforeSuffix > 0 && !isVowelOrJ(word[beforeSuffix - 1])) {
      return word.slice(0, -1)
    }
  }

  return word
}

function step2(word: string, r1: number): { word: string; removedE: boolean } {
  if (word.endsWith('e') && word.length - 1 >= r1) {
    const beforeSuffix = word.length - 1
    if (beforeSuffix > 0 && !isVowel(word[beforeSuffix - 1])) {
      return { word: undouble(word.slice(0, -1)), removedE: true }
    }
  }
  return { word, removedE: false }
}

function step3a(word: string, r2: number): string {
  if (word.endsWith('heid') && word.length - 4 >= r2) {
    if (!word.slice(0, -4).endsWith('c')) {
      return word.slice(0, -4)
    }
  }
  return word
}

function step3b(word: string, r1: number, r2: number, removedE: boolean): string {
  if (word.endsWith('end') && word.length - 3 >= r2) {
    word = word.slice(0, -3)
    if (word.endsWith('ig') && word.length - 2 >= r2 && !word.endsWith('eig')) {
      return word.slice(0, -2)
    }
    return undouble(word)
  }

  if (word.endsWith('ing') && word.length - 3 >= r2) {
    word = word.slice(0, -3)
    if (word.endsWith('ig') && word.length - 2 >= r2 && !word.endsWith('eig')) {
      return word.slice(0, -2)
    }
    return undouble(word)
  }

  if (word.endsWith('ig') && word.length - 2 >= r2) {
    if (!word.endsWith('eig')) {
      return word.slice(0, -2)
    }
    return word
  }

  if (word.endsWith('lijk') && word.length - 4 >= r2) {
    word = word.slice(0, -4)
    const result = step2(word, r1)
    return result.word
  }

  if (word.endsWith('baar') && word.length - 4 >= r2) {
    return word.slice(0, -4)
  }

  if (word.endsWith('bar') && word.length - 3 >= r2) {
    if (removedE) {
      return word.slice(0, -3)
    }
    return word
  }

  return word
}

const DOUBLE_VOWELS = ['aa', 'ee', 'oo', 'uu']

function undoubleVowel(word: string): string {
  if (word.length < 4) return word

  const lastChar = word[word.length - 1]
  if (isVowel(lastChar) || lastChar === 'I' || lastChar === 'Y') return word

  const penultimate = word.slice(word.length - 3, word.length - 1)
  if (!DOUBLE_VOWELS.includes(penultimate)) return word

  const charBeforeDouble = word[word.length - 4]
  if (charBeforeDouble === undefined || isVowel(charBeforeDouble)) return word

  return word.slice(0, word.length - 2) + word[word.length - 1]
}

const RE_UPPERCASE_I = /I/g
const RE_UPPERCASE_Y = /Y/g

function restoreCase(word: string): string {
  return word.replace(RE_UPPERCASE_I, 'i').replace(RE_UPPERCASE_Y, 'y')
}

function stem(word: string): string {
  if (word.length < 3) return word

  word = word.toLowerCase()
  word = markConsonantIY(word)

  const { r1, r2 } = findRegions(word)

  word = step1(word, r1)

  const step2Result = step2(word, r1)
  word = step2Result.word
  const removedE = step2Result.removedE

  const beforeStep3a = word
  word = step3a(word, r2)
  if (word !== beforeStep3a) {
    word = removeEnSuffix(word, r1)
  }

  word = step3b(word, r1, r2, removedE)

  word = undoubleVowel(word)
  word = restoreCase(word)

  return word
}

const stopWords = new Set([
  'de',
  'en',
  'van',
  'ik',
  'te',
  'dat',
  'die',
  'in',
  'een',
  'hij',
  'het',
  'niet',
  'zijn',
  'is',
  'was',
  'op',
  'aan',
  'met',
  'als',
  'voor',
  'had',
  'er',
  'maar',
  'om',
  'hem',
  'dan',
  'zou',
  'of',
  'wat',
  'mijn',
  'men',
  'dit',
  'zo',
  'door',
  'over',
  'ze',
  'zich',
  'bij',
  'ook',
  'tot',
  'je',
  'mij',
  'uit',
  'der',
  'daar',
  'haar',
  'naar',
  'heb',
  'hoe',
  'heeft',
  'hebben',
  'deze',
  'u',
  'want',
  'nog',
  'zal',
  'me',
  'zij',
  'nu',
  'ge',
  'geen',
  'omdat',
  'iets',
  'worden',
  'toch',
  'al',
  'waren',
  'veel',
  'meer',
  'doen',
  'toen',
  'moet',
  'ben',
  'zonder',
  'kan',
  'hun',
  'dus',
  'alles',
  'onder',
  'ja',
  'eens',
  'hier',
  'wie',
  'werd',
  'altijd',
  'doch',
  'wordt',
  'wezen',
  'kunnen',
  'ons',
  'zelf',
  'tegen',
  'na',
  'reeds',
  'wil',
  'kon',
  'niets',
  'uw',
  'iemand',
  'geweest',
  'andere',
])

export const dutch: LanguageModule = {
  name: 'dutch',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9àèéìòóù'-]+/gi },
}
