import type { LanguageModule } from '../types/language'

const VOWELS = 'aăâeiîou'

const RE_UPPER_I = /I/g
const RE_UPPER_U = /U/g

const STEP0_SUFFIXES = [
  'iilor',
  'ilor',
  'elor',
  'ului',
  'iile',
  'atei',
  'ație',
  'ația',
  'ele',
  'ile',
  'iei',
  'ul',
  'ea',
  'ii',
  'ua',
  'iua',
  'aua',
  'a',
]

const STEP1_SUFFIX_GROUPS: [string[], number, string][] = [
  [['abilitate', 'abilitati', 'abilități', 'abilitați'].sort((a, b) => b.length - a.length), 1, 'abil'],
  [['ibilitate', 'ibilitati', 'ibilități', 'ibilitați'].sort((a, b) => b.length - a.length), 2, 'ibil'],
  [['ivitate', 'ivitati', 'ivități', 'ivitați'].sort((a, b) => b.length - a.length), 3, 'iv'],
  [
    [
      'icală',
      'icale',
      'icali',
      'ical',
      'ică',
      'ice',
      'ici',
      'ic',
      'icitate',
      'icitati',
      'icitați',
      'icități',
      'iciva',
      'icive',
      'icivi',
      'iciv',
      'icivă',
      'icator',
      'icatori',
      'icatoare',
      'icătoare',
      'icători',
    ].sort((a, b) => b.length - a.length),
    4,
    'ic',
  ],
  [
    ['ativă', 'ative', 'ativi', 'ativ', 'ativa', 'ație', 'ațiune', 'ator', 'atori', 'atoare', 'ătoare', 'ători'].sort(
      (a, b) => b.length - a.length,
    ),
    5,
    'at',
  ],
  [
    ['itivă', 'itive', 'itivi', 'itiv', 'itiva', 'iție', 'ițiune', 'itor', 'itori', 'itoare'].sort(
      (a, b) => b.length - a.length,
    ),
    6,
    'it',
  ],
]

const STEP1_STANDARD_SUFFIXES: [string[], string | null][] = [
  [['abilă', 'abile', 'abili', 'abil', 'abila'].sort((a, b) => b.length - a.length), null],
  [['ibilă', 'ibile', 'ibili', 'ibil', 'ibila'].sort((a, b) => b.length - a.length), null],
  [['oasă', 'oase', 'oasa', 'os', 'oși'].sort((a, b) => b.length - a.length), null],
  [
    [
      'ată',
      'ate',
      'ati',
      'at',
      'ata',
      'ită',
      'ite',
      'iti',
      'it',
      'ita',
      'antă',
      'ante',
      'anti',
      'ant',
      'anta',
      'ută',
      'ute',
      'uti',
      'ut',
      'uta',
      'ivă',
      'ive',
      'ivi',
      'iv',
      'iva',
      'iune',
      'iuni',
      'itate',
      'itati',
      'itați',
      'ități',
    ].sort((a, b) => b.length - a.length),
    null,
  ],
  [['istă', 'iste', 'isti', 'ist', 'ista', 'ism', 'isme', 'iști'].sort((a, b) => b.length - a.length), 'ist'],
]

const STEP2_SUFFIXES = [
  'seserăți',
  'aserăți',
  'iserăți',
  'userăți',
  'âserăți',
  'serăți',
  'seserăm',
  'aserăm',
  'iserăm',
  'userăm',
  'âserăm',
  'serăm',
  'sesești',
  'asești',
  'isești',
  'usești',
  'âsești',
  'sești',
  'arăți',
  'irăți',
  'urăți',
  'ârăți',
  'arăm',
  'irăm',
  'urăm',
  'ârăm',
  'eați',
  'iați',
  'ați',
  'eam',
  'iam',
  'am',
  'ează',
  'eți',
  'iți',
  'âți',
  'ară',
  'iră',
  'ură',
  'âră',
  'seră',
  'aseră',
  'iseră',
  'useră',
  'âseră',
  'seseră',
  'easc',
  'esc',
  'ăsc',
  'ește',
  'ăște',
  'ești',
  'ăști',
  'are',
  'ere',
  'ire',
  'âre',
  'ase',
  'ise',
  'use',
  'âse',
  'sese',
  'se',
  'ind',
  'ând',
  'indu',
  'ându',
  'eze',
  'ezi',
  'ez',
  'eai',
  'iai',
  'ai',
  'âi',
  'ui',
  'sei',
  'asem',
  'isem',
  'usem',
  'âsem',
  'sesem',
  'em',
  'im',
  'âm',
  'ăm',
  'eau',
  'iau',
  'au',
  'ași',
  'iși',
  'uși',
  'âși',
].sort((a, b) => b.length - a.length)

const STEP2_VERB_GROUP_SESE = new Set([
  'sese',
  'sesem',
  'sesești',
  'seserăm',
  'seserăți',
  'se',
  'sei',
  'sești',
  'seră',
  'seseră',
  'serăm',
  'serăți',
])

const STEP3_SUFFIXES = ['ie', 'ă', 'e', 'i', 'a']

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch)
}

function isLowerVowel(ch: string): boolean {
  return VOWELS.includes(ch) || ch === 'I' || ch === 'U'
}

/**
 * Mark i and u between vowels as consonants using uppercase (I, U).
 * This follows the Snowball Romanian convention where i/u in
 * vowel-i/u-vowel positions act as consonants.
 */
function markVowelAsConsonant(word: string): string {
  const chars = word.split('')
  for (let i = 1; i < chars.length - 1; i++) {
    if (isVowel(chars[i - 1]) && isVowel(chars[i + 1])) {
      if (chars[i] === 'u') chars[i] = 'U'
      if (chars[i] === 'i') chars[i] = 'I'
    }
  }
  return chars.join('')
}

function computeRegions(word: string): { rv: number; r1: number; r2: number } {
  let rv = word.length
  let r1 = word.length
  let r2 = word.length

  if (word.length >= 2) {
    if (isLowerVowel(word[0])) {
      if (isLowerVowel(word[1])) {
        let i = 2
        while (i < word.length && isLowerVowel(word[i])) i++
        if (i < word.length) {
          i++
          rv = i
        }
      } else {
        let i = 2
        while (i < word.length && !isLowerVowel(word[i])) i++
        if (i < word.length) {
          rv = i + 1
        }
      }
    } else if (isLowerVowel(word[1])) {
      let i = 2
      while (i < word.length && !isLowerVowel(word[i])) i++
      if (i < word.length) {
        rv = i + 1
      }
    } else {
      let i = 2
      while (i < word.length) {
        if (isLowerVowel(word[i])) {
          rv = i + 1
          break
        }
        i++
      }
    }
  }

  let i = 1
  while (i < word.length) {
    if (!isLowerVowel(word[i]) && isLowerVowel(word[i - 1])) {
      r1 = i + 1
      break
    }
    i++
  }

  i = r1 + 1
  while (i < word.length) {
    if (!isLowerVowel(word[i]) && isLowerVowel(word[i - 1])) {
      r2 = i + 1
      break
    }
    i++
  }

  return { rv, r1, r2 }
}

function inRegion(word: string, regionStart: number, suffixLen: number): boolean {
  return word.length - suffixLen >= regionStart
}

function trySuffix(word: string, suffixes: string[]): string | null {
  for (const s of suffixes) {
    if (word.endsWith(s)) return s
  }
  return null
}

function step0(word: string, r1: number): string {
  const matched = trySuffix(word, STEP0_SUFFIXES)
  if (matched && inRegion(word, r1, matched.length)) {
    switch (matched) {
      case 'ul':
      case 'ului':
        return word.slice(0, -matched.length)

      case 'aua':
        return `${word.slice(0, -matched.length)}a`

      case 'ea':
      case 'ele':
      case 'elor':
        return `${word.slice(0, -matched.length)}e`

      case 'iua':
      case 'iei':
      case 'ile':
      case 'iile':
      case 'ilor':
      case 'iilor':
      case 'ii':
        return `${word.slice(0, -matched.length)}i`

      case 'ația':
      case 'ație':
      case 'atei':
        return `${word.slice(0, -matched.length)}ați`

      case 'ua':
        return word.slice(0, -matched.length)

      case 'a':
        return word.slice(0, -1)

      default:
        return word.slice(0, -matched.length)
    }
  }
  return word
}

function step1(word: string, _r1: number, r2: number): { word: string; changed: boolean } {
  for (const [suffixes, _id, replacement] of STEP1_SUFFIX_GROUPS) {
    const matched = trySuffix(word, suffixes)
    if (matched && inRegion(word, r2, matched.length)) {
      return { word: `${word.slice(0, -matched.length)}${replacement}`, changed: true }
    }
  }

  for (const [suffixes, replacement] of STEP1_STANDARD_SUFFIXES) {
    const matched = trySuffix(word, suffixes)
    if (matched && inRegion(word, r2, matched.length)) {
      if (replacement === 'ist') {
        return { word: `${word.slice(0, -matched.length)}ist`, changed: true }
      }
      const stripped = word.slice(0, -matched.length)
      if (matched === 'iune' || matched === 'iuni') {
        if (stripped.endsWith('ț')) {
          return { word: `${stripped.slice(0, -1)}t`, changed: true }
        }
      }
      return { word: stripped, changed: true }
    }
  }

  return { word, changed: false }
}

function step2(word: string, rv: number): { word: string; changed: boolean } {
  const matched = trySuffix(word, STEP2_SUFFIXES)

  if (matched && inRegion(word, rv, matched.length)) {
    const stripped = word.slice(0, -matched.length)

    if (STEP2_VERB_GROUP_SESE.has(matched)) {
      if (!isVowel(stripped[stripped.length - 1]) && stripped[stripped.length - 1] !== 'u') {
        return { word, changed: false }
      }
    }

    return { word: stripped, changed: true }
  }

  return { word, changed: false }
}

function step3(word: string, rv: number): string {
  const matched = trySuffix(word, STEP3_SUFFIXES)
  if (matched && inRegion(word, rv, matched.length)) {
    return word.slice(0, -matched.length)
  }

  return word
}

function restoreMarked(word: string): string {
  return word.replace(RE_UPPER_I, 'i').replace(RE_UPPER_U, 'u')
}

function stem(word: string): string {
  if (word.length < 3) return word

  word = word.toLowerCase()
  word = markVowelAsConsonant(word)

  const { rv, r1, r2 } = computeRegions(word)

  word = step0(word, r1)

  const result1 = step1(word, r1, r2)
  word = result1.word
  const step1Changed = result1.changed

  if (!step1Changed) {
    const result2 = step2(word, rv)
    word = result2.word
  }

  word = step3(word, rv)
  word = restoreMarked(word)

  return word
}

const stopWords = new Set([
  'acea',
  'aceasta',
  'această',
  'aceea',
  'acei',
  'aceia',
  'acel',
  'acela',
  'acele',
  'acelea',
  'acest',
  'acesta',
  'aceste',
  'acestea',
  'aceşti',
  'aceştia',
  'acolo',
  'acum',
  'ai',
  'aici',
  'al',
  'ale',
  'altceva',
  'altcineva',
  'am',
  'ar',
  'are',
  'asemenea',
  'asta',
  'astea',
  'astăzi',
  'asupra',
  'au',
  'avea',
  'avem',
  'aveţi',
  'azi',
  'aş',
  'aşadar',
  'aţi',
  'bine',
  'ca',
  'care',
  'ce',
  'cel',
  'ceva',
  'chiar',
  'cine',
  'cineva',
  'contra',
  'cu',
  'cum',
  'cumva',
  'când',
  'cât',
  'câte',
  'câţi',
  'că',
  'căci',
  'cărei',
  'căror',
  'cărui',
  'către',
  'da',
  'dacă',
  'dar',
  'datorită',
  'dată',
  'de',
  'deci',
  'deja',
  'deoarece',
  'departe',
  'deşi',
  'din',
  'dintre',
  'doi',
  'două',
  'drept',
  'după',
  'ea',
  'ei',
  'el',
  'ele',
  'eram',
  'este',
  'eu',
  'eşti',
  'face',
  'fi',
  'fie',
  'fiecare',
  'fii',
  'fim',
  'fiu',
  'fiţi',
  'fără',
  'iar',
  'ieri',
  'la',
  'le',
  'li',
  'lor',
  'lui',
  'lângă',
  'mai',
  'mea',
  'mei',
  'mele',
  'mereu',
  'meu',
  'mi',
  'mie',
  'mine',
  'mult',
  'multă',
  'mulţi',
  'mâine',
  'mă',
  'ne',
  'nevoie',
  'nici',
  'nicăieri',
  'nimeni',
  'nimic',
  'nişte',
  'noastre',
  'noastră',
  'noi',
  'nostru',
  'nouă',
  'noştri',
  'nu',
  'ori',
  'oricare',
  'orice',
  'oricine',
  'oricum',
  'oricând',
  'oricât',
  'oriunde',
  'pe',
  'pentru',
  'peste',
  'poate',
  'pot',
  'prea',
  'prima',
  'primul',
  'prin',
  'puţin',
  'până',
  'sa',
  'sale',
  'sau',
  'se',
  'spre',
  'sub',
  'sunt',
  'suntem',
  'sunteţi',
  'să',
  'săi',
  'său',
  'ta',
  'tale',
  'te',
  'timp',
  'tine',
  'toate',
  'toată',
  'tot',
  'totuşi',
  'toţi',
  'trei',
  'tu',
  'tăi',
  'tău',
  'un',
  'una',
  'unde',
  'undeva',
  'unei',
  'unele',
  'unii',
  'unor',
  'unu',
  'unui',
  'unul',
  'vi',
  'voastre',
  'voastră',
  'voi',
  'vostru',
  'vouă',
  'voştri',
  'vreme',
  'vreo',
  'vreun',
  'vă',
  'zece',
  'zi',
  'îi',
  'îl',
  'îmi',
  'împotriva',
  'în',
  'înainte',
  'înaintea',
  'încotro',
  'încât',
  'între',
  'întrucât',
  'îţi',
  'ăla',
  'ălea',
  'ăsta',
  'ăstea',
  'şapte',
  'şase',
  'şi',
  'ţi',
  'ţie',
])

export const romanian: LanguageModule = {
  name: 'romanian',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9ăâîșț]+/gi },
}
