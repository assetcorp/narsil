import type { LanguageModule } from '../types/language'

const VOWELS = 'aeiouáéíóú'

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch)
}

function findRegions(word: string): { r1: number; r2: number; rv: number } {
  let r1 = word.length
  let r2 = word.length
  let rv = word.length

  for (let i = 1; i < word.length; i++) {
    if (!isVowel(word[i]) && isVowel(word[i - 1])) {
      r1 = i + 1
      break
    }
  }

  for (let i = r1 + 1; i < word.length; i++) {
    if (!isVowel(word[i]) && isVowel(word[i - 1])) {
      r2 = i + 1
      break
    }
  }

  let foundConsonantCluster = false
  for (let i = 0; i < word.length; i++) {
    if (!foundConsonantCluster) {
      if (!isVowel(word[i])) continue
      foundConsonantCluster = false
      for (let j = i + 1; j < word.length; j++) {
        if (!isVowel(word[j])) {
          rv = j + 1
          foundConsonantCluster = true
          break
        }
      }
      if (foundConsonantCluster) break
    }
  }

  return { r1, r2, rv }
}

const INITIAL_MUTATIONS: [string, string][] = [
  ['bhf', 'f'],
  ['mb', 'b'],
  ['gc', 'c'],
  ['nd', 'd'],
  ['ng', 'g'],
  ['bp', 'p'],
  ['ts', 's'],
  ['dt', 't'],
]

function removeInitialMutations(word: string): string {
  if (word.startsWith("d'") || word.startsWith("b'")) {
    const rest = word.slice(2)
    if (rest.length > 0 && isVowel(rest[0])) {
      return rest
    }
  }

  if (word.startsWith('h-') || word.startsWith('n-') || word.startsWith('t-')) {
    const rest = word.slice(2)
    if (rest.length > 0 && isVowel(rest[0])) {
      return rest
    }
  }

  for (const [mutation, replacement] of INITIAL_MUTATIONS) {
    if (word.startsWith(mutation)) {
      return `${replacement}${word.slice(mutation.length)}`
    }
  }

  return word
}

const NOUN_SUFFIXES = [
  'arcachtaí',
  'eachtaí',
  'gineadach',
  'aíochtaí',
  'achtaí',
  'íochtaí',
  'aíochta',
  'eachta',
  'gineas',
  'éaltas',
  'íochta',
  'aíocht',
  'eanna',
  'achta',
  'eacht',
  'anna',
  'acht',
  'aire',
  'ire',
]

const VERB_SUFFIXES = [
  'aíomar',
  'aítear',
  'aimid',
  'aimís',
  'aimis',
  'aíodh',
  'aíonn',
  'eamar',
  'imid',
  'ímid',
  'ímís',
  'imis',
  'tear',
  'eadh',
  'aidh',
  'igh',
  'ann',
  'adh',
]

function removeSuffixInRegion(word: string, suffixes: string[], regionStart: number): string | null {
  for (const suffix of suffixes) {
    if (word.endsWith(suffix) && word.length - suffix.length >= regionStart) {
      return word.slice(0, word.length - suffix.length)
    }
  }
  return null
}

function stem(word: string): string {
  if (word.length < 3) return word

  word = removeInitialMutations(word)
  if (word.length < 3) return word

  const { r2, rv } = findRegions(word)

  const nounResult = removeSuffixInRegion(word, NOUN_SUFFIXES, r2)
  if (nounResult !== null) {
    word = nounResult
  } else {
    const verbResult = removeSuffixInRegion(word, VERB_SUFFIXES, rv)
    if (verbResult !== null) {
      word = verbResult
    }
  }

  return word
}

const stopWords = new Set([
  'a',
  'ach',
  'ag',
  'agus',
  'an',
  'aon',
  'ar',
  'arna',
  'as',
  'b',
  'ba',
  'beirt',
  'bhúr',
  'caoga',
  'ceathair',
  'ceathrar',
  'chomh',
  'chtó',
  'chuig',
  'chun',
  'cois',
  'céad',
  'cúig',
  'cúigear',
  'd',
  'daichead',
  'dar',
  'de',
  'deich',
  'deichniúr',
  'den',
  'dhá',
  'do',
  'don',
  'dtí',
  'dá',
  'dár',
  'dó',
  'faoi',
  'faoin',
  'faoina',
  'faoinár',
  'fara',
  'fiche',
  'gach',
  'gan',
  'go',
  'gur',
  'haon',
  'hocht',
  'i',
  'iad',
  'idir',
  'in',
  'ina',
  'ins',
  'inár',
  'is',
  'le',
  'leis',
  'lena',
  'lenár',
  'm',
  'mar',
  'mo',
  'mé',
  'na',
  'nach',
  'naoi',
  'naonúr',
  'ná',
  'ní',
  'níor',
  'nó',
  'nócha',
  'ocht',
  'ochtar',
  'os',
  'roimh',
  'sa',
  'seacht',
  'seachtar',
  'seachtó',
  'seasca',
  'seisear',
  'siad',
  'sibh',
  'sinn',
  'sna',
  'sé',
  'sí',
  'tar',
  'thar',
  'thú',
  'triúr',
  'trí',
  'trína',
  'trínár',
  'tríocha',
  'tú',
  'um',
  'ár',
  'é',
  'éis',
  'í',
  'ó',
  'ón',
  'óna',
  'ónár',
])

export const irish: LanguageModule = {
  name: 'irish',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9áéíóú]+/gi },
}
