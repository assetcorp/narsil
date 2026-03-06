import type { LanguageModule } from '../types/language'

const VOWELS = 'aeiouàèéìòóù'
const RE_QU = /qu/g

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch)
}

function findRegions(word: string): { rv: number; r1: number; r2: number } {
  const length = word.length

  let rv = length
  if (length > 3) {
    if (!isVowel(word[1])) {
      for (let i = 2; i < length; i++) {
        if (isVowel(word[i])) {
          rv = i + 1
          break
        }
      }
    } else if (isVowel(word[0]) && isVowel(word[1])) {
      for (let i = 2; i < length; i++) {
        if (!isVowel(word[i])) {
          rv = i + 1
          break
        }
      }
    } else {
      rv = 3
    }
  }

  let r1 = length
  for (let i = 1; i < length; i++) {
    if (!isVowel(word[i]) && isVowel(word[i - 1])) {
      r1 = i + 1
      break
    }
  }

  let r2 = length
  for (let i = r1 + 1; i < length; i++) {
    if (!isVowel(word[i]) && isVowel(word[i - 1])) {
      r2 = i + 1
      break
    }
  }

  return { rv, r1, r2 }
}

const RE_ACCENT_A = /á/g
const RE_ACCENT_E = /é/g
const RE_ACCENT_I = /í/g
const RE_ACCENT_O = /ó/g
const RE_ACCENT_U = /ú/g

function replaceAccentedVowels(word: string): string {
  return word
    .replace(RE_ACCENT_A, 'à')
    .replace(RE_ACCENT_E, 'è')
    .replace(RE_ACCENT_I, 'ì')
    .replace(RE_ACCENT_O, 'ò')
    .replace(RE_ACCENT_U, 'ù')
}

function markVowelPairsAsUppercase(word: string): string {
  let result = ''
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]
    if (i > 0 && i < word.length - 1 && isVowel(word[i - 1]) && isVowel(word[i + 1])) {
      if (ch === 'i') {
        result += 'I'
        continue
      }
      if (ch === 'u') {
        result += 'U'
        continue
      }
    }
    result += ch
  }
  return result
}

const RE_UPPERCASE_I = /I/g
const RE_UPPERCASE_U = /U/g

function restoreMarkedVowels(word: string): string {
  return word.replace(RE_UPPERCASE_I, 'i').replace(RE_UPPERCASE_U, 'u')
}

function endsWith(word: string, suffix: string): boolean {
  return word.endsWith(suffix)
}

function suffixInRegion(word: string, suffix: string, regionStart: number): boolean {
  return word.length - suffix.length >= regionStart
}

function removeSuffix(word: string, suffix: string): string {
  return word.slice(0, word.length - suffix.length)
}

/**
 * Standard suffix removal for Italian (Snowball step 1).
 *
 * Suffix groups and their region requirements:
 *   - Group A (R2 delete): ica, ice, ico, ici, iche, ichi, ismo, ismi, ista, iste, isti,
 *     istà, istè, istì, osa, ose, oso, osi, ante, anti, abile, abili, ibile, ibili,
 *     atrice, atrici, mente, anza, anze
 *   - Group B (R2 delete + optionally delete 'ic' in R2): azione, azioni, atore, atori
 *   - Group C (R2 replace with 'log'): logia, logie
 *   - Group D (R2 replace with 'u'): uzione, uzioni, usione, usioni
 *   - Group E (R2 replace with 'ente'): enza, enze
 *   - Group F (RV delete): amento, amenti, imento, imenti
 *   - Group G (R1 delete + optional sub-deletions in R2): amente
 *   - Group H (R2 delete + optional sub-deletions in R2): ità
 *   - Group I (R2 delete + optional 'at' then 'ic' in R2): iva, ive, ivo, ivi
 */

interface SuffixSpec {
  suffix: string
  group: string
}

const STANDARD_SUFFIXES: SuffixSpec[] = [
  { suffix: 'atrice', group: 'A' },
  { suffix: 'atrici', group: 'A' },
  { suffix: 'azione', group: 'B' },
  { suffix: 'azioni', group: 'B' },
  { suffix: 'uzione', group: 'D' },
  { suffix: 'uzioni', group: 'D' },
  { suffix: 'usione', group: 'D' },
  { suffix: 'usioni', group: 'D' },
  { suffix: 'amento', group: 'F' },
  { suffix: 'amenti', group: 'F' },
  { suffix: 'imento', group: 'F' },
  { suffix: 'imenti', group: 'F' },
  { suffix: 'amente', group: 'G' },
  { suffix: 'atore', group: 'B' },
  { suffix: 'atori', group: 'B' },
  { suffix: 'mente', group: 'A' },
  { suffix: 'logia', group: 'C' },
  { suffix: 'logie', group: 'C' },
  { suffix: 'abile', group: 'A' },
  { suffix: 'abili', group: 'A' },
  { suffix: 'ibile', group: 'A' },
  { suffix: 'ibili', group: 'A' },
  { suffix: 'ista', group: 'A' },
  { suffix: 'iste', group: 'A' },
  { suffix: 'isti', group: 'A' },
  { suffix: 'ist\u00e0', group: 'A' },
  { suffix: 'ist\u00e8', group: 'A' },
  { suffix: 'ist\u00ec', group: 'A' },
  { suffix: 'anza', group: 'A' },
  { suffix: 'anze', group: 'A' },
  { suffix: 'enza', group: 'E' },
  { suffix: 'enze', group: 'E' },
  { suffix: 'iche', group: 'A' },
  { suffix: 'ichi', group: 'A' },
  { suffix: 'ismo', group: 'A' },
  { suffix: 'ismi', group: 'A' },
  { suffix: 'ante', group: 'A' },
  { suffix: 'anti', group: 'A' },
  { suffix: 'ica', group: 'A' },
  { suffix: 'ice', group: 'A' },
  { suffix: 'ico', group: 'A' },
  { suffix: 'ici', group: 'A' },
  { suffix: 'osa', group: 'A' },
  { suffix: 'ose', group: 'A' },
  { suffix: 'oso', group: 'A' },
  { suffix: 'osi', group: 'A' },
  { suffix: 'iva', group: 'I' },
  { suffix: 'ive', group: 'I' },
  { suffix: 'ivo', group: 'I' },
  { suffix: 'ivi', group: 'I' },
  { suffix: 'it\u00e0', group: 'H' },
]

function findLongestSuffix(word: string, suffixes: SuffixSpec[]): SuffixSpec | null {
  let best: SuffixSpec | null = null
  for (const entry of suffixes) {
    if (endsWith(word, entry.suffix)) {
      if (best === null || entry.suffix.length > best.suffix.length) {
        best = entry
      }
    }
  }
  return best
}

function removeStandardSuffix(word: string, r1: number, r2: number, rv: number): { word: string; changed: boolean } {
  const match = findLongestSuffix(word, STANDARD_SUFFIXES)
  if (match === null) return { word, changed: false }

  const { suffix, group } = match

  if (group === 'A') {
    if (!suffixInRegion(word, suffix, r2)) return { word, changed: false }
    return { word: removeSuffix(word, suffix), changed: true }
  }

  if (group === 'B') {
    if (!suffixInRegion(word, suffix, r2)) return { word, changed: false }
    word = removeSuffix(word, suffix)
    if (endsWith(word, 'ic') && suffixInRegion(word, 'ic', r2)) {
      word = removeSuffix(word, 'ic')
    }
    return { word, changed: true }
  }

  if (group === 'C') {
    if (!suffixInRegion(word, suffix, r2)) return { word, changed: false }
    return { word: `${removeSuffix(word, suffix)}log`, changed: true }
  }

  if (group === 'D') {
    if (!suffixInRegion(word, suffix, r2)) return { word, changed: false }
    return { word: `${removeSuffix(word, suffix)}u`, changed: true }
  }

  if (group === 'E') {
    if (!suffixInRegion(word, suffix, r2)) return { word, changed: false }
    return { word: `${removeSuffix(word, suffix)}ente`, changed: true }
  }

  if (group === 'F') {
    if (!suffixInRegion(word, suffix, rv)) return { word, changed: false }
    return { word: removeSuffix(word, suffix), changed: true }
  }

  if (group === 'G') {
    if (!suffixInRegion(word, suffix, r1)) return { word, changed: false }
    word = removeSuffix(word, suffix)
    if (endsWith(word, 'iv') && suffixInRegion(word, 'iv', r2)) {
      word = removeSuffix(word, 'iv')
      if (endsWith(word, 'at') && suffixInRegion(word, 'at', r2)) {
        word = removeSuffix(word, 'at')
      }
    } else if (endsWith(word, 'os') && suffixInRegion(word, 'os', r2)) {
      word = removeSuffix(word, 'os')
    } else if (endsWith(word, 'ic') && suffixInRegion(word, 'ic', r2)) {
      word = removeSuffix(word, 'ic')
    } else if (endsWith(word, 'abil') && suffixInRegion(word, 'abil', r2)) {
      word = removeSuffix(word, 'abil')
    }
    return { word, changed: true }
  }

  if (group === 'H') {
    if (!suffixInRegion(word, suffix, r2)) return { word, changed: false }
    word = removeSuffix(word, suffix)
    if (endsWith(word, 'abil') && suffixInRegion(word, 'abil', r2)) {
      word = removeSuffix(word, 'abil')
    } else if (endsWith(word, 'ic') && suffixInRegion(word, 'ic', r2)) {
      word = removeSuffix(word, 'ic')
    } else if (endsWith(word, 'iv') && suffixInRegion(word, 'iv', r2)) {
      word = removeSuffix(word, 'iv')
    }
    return { word, changed: true }
  }

  if (group === 'I') {
    if (!suffixInRegion(word, suffix, r2)) return { word, changed: false }
    word = removeSuffix(word, suffix)
    if (endsWith(word, 'at') && suffixInRegion(word, 'at', r2)) {
      word = removeSuffix(word, 'at')
      if (endsWith(word, 'ic') && suffixInRegion(word, 'ic', r2)) {
        word = removeSuffix(word, 'ic')
      }
    }
    return { word, changed: true }
  }

  return { word, changed: false }
}

const VERB_SUFFIXES = [
  'erebbero',
  'irebbero',
  'erebbe',
  'irebbe',
  'assero',
  'essero',
  'issero',
  'assimo',
  'eremmo',
  'iremmo',
  'eranno',
  'iranno',
  'ereste',
  'ireste',
  'iscano',
  'iscono',
  'eremo',
  'iremo',
  'avamo',
  'evamo',
  'ivamo',
  'avate',
  'evate',
  'ivate',
  'erete',
  'irete',
  'arono',
  'erono',
  'irono',
  'avano',
  'evano',
  'ivano',
  'eresti',
  'iresti',
  'isco',
  'isca',
  'isce',
  'isci',
  'ando',
  'endo',
  'Yamo',
  'iamo',
  'ammo',
  'emmo',
  'immo',
  'asse',
  'aste',
  'este',
  'iste',
  'erai',
  'irai',
  'erei',
  'irei',
  'ava',
  'eva',
  'iva',
  'ata',
  'ita',
  'uta',
  'ate',
  'ete',
  'ite',
  'ute',
  'ati',
  'iti',
  'uti',
  'ato',
  'ito',
  'uto',
  'avo',
  'evo',
  'ivo',
  'ano',
  'ono',
  'are',
  'ere',
  'ire',
  'assi',
  'avi',
  'evi',
  'ivi',
  'endi',
  'ar',
  'ir',
  'er\u00e0',
  'ir\u00e0',
  'er\u00f2',
  'ir\u00f2',
]

const ATTACHED_PRONOUN_SUFFIXES = [
  'gliela',
  'gliele',
  'glieli',
  'glielo',
  'gliene',
  'cela',
  'cele',
  'celi',
  'celo',
  'cene',
  'mela',
  'mele',
  'meli',
  'melo',
  'mene',
  'sene',
  'tela',
  'tele',
  'teli',
  'telo',
  'tene',
  'vela',
  'vele',
  'veli',
  'velo',
  'vene',
  'gli',
  'la',
  'le',
  'li',
  'lo',
  'ci',
  'mi',
  'ne',
  'si',
  'ti',
  'vi',
]

const ATTACHED_PRONOUN_PRECEDING = ['ando', 'endo', 'ar', 'er', 'ir']

function removeAttachedPronouns(word: string, rv: number): string {
  let longestPronoun: string | null = null
  for (const pronoun of ATTACHED_PRONOUN_SUFFIXES) {
    if (endsWith(word, pronoun) && suffixInRegion(word, pronoun, rv)) {
      if (longestPronoun === null || pronoun.length > longestPronoun.length) {
        longestPronoun = pronoun
      }
    }
  }

  if (longestPronoun === null) return word

  const stemmed = removeSuffix(word, longestPronoun)
  for (const preceding of ATTACHED_PRONOUN_PRECEDING) {
    if (endsWith(stemmed, preceding)) {
      if (preceding === 'ar' || preceding === 'er' || preceding === 'ir') {
        return `${removeSuffix(stemmed, preceding) + preceding}e`
      }
      return stemmed
    }
  }

  return word
}

function removeVerbSuffix(word: string, rv: number): { word: string; changed: boolean } {
  let longestSuffix: string | null = null
  for (const suffix of VERB_SUFFIXES) {
    if (endsWith(word, suffix)) {
      if (longestSuffix === null || suffix.length > longestSuffix.length) {
        longestSuffix = suffix
      }
    }
  }

  if (longestSuffix !== null && suffixInRegion(word, longestSuffix, rv)) {
    return { word: removeSuffix(word, longestSuffix), changed: true }
  }

  return { word, changed: false }
}

function removeResidualSuffix(word: string, rv: number): string {
  const lastChar = word[word.length - 1]
  if (
    lastChar === 'a' ||
    lastChar === 'e' ||
    lastChar === 'i' ||
    lastChar === 'o' ||
    lastChar === '\u00e0' ||
    lastChar === '\u00e8' ||
    lastChar === '\u00ec' ||
    lastChar === '\u00f2'
  ) {
    if (suffixInRegion(word, lastChar, rv)) {
      word = word.slice(0, -1)
      if (word.length > 0 && word[word.length - 1] === 'i' && suffixInRegion(word, 'i', rv)) {
        word = word.slice(0, -1)
      }
    }
  }

  if (endsWith(word, 'h') && suffixInRegion(word, 'h', rv)) {
    const twoBack = word.length >= 2 ? word[word.length - 2] : ''
    if (twoBack === 'c' || twoBack === 'g') {
      word = word.slice(0, -1)
    }
  }

  return word
}

function stem(word: string): string {
  if (word.length < 3) return word

  word = word.toLowerCase()
  word = replaceAccentedVowels(word)
  word = word.replace(RE_QU, 'qU')
  word = markVowelPairsAsUppercase(word)

  const { rv, r1, r2 } = findRegions(word)

  word = removeAttachedPronouns(word, rv)

  const standardResult = removeStandardSuffix(word, r1, r2, rv)
  if (standardResult.changed) {
    word = standardResult.word
  } else {
    const verbResult = removeVerbSuffix(word, rv)
    word = verbResult.word
  }

  word = removeResidualSuffix(word, rv)
  word = restoreMarkedVowels(word)

  return word
}

const stopWords = new Set([
  'ad',
  'al',
  'allo',
  'ai',
  'agli',
  'all',
  'agl',
  'alla',
  'alle',
  'con',
  'col',
  'coi',
  'da',
  'dal',
  'dallo',
  'dai',
  'dagli',
  'dall',
  'dagl',
  'dalla',
  'dalle',
  'di',
  'del',
  'dello',
  'dei',
  'degli',
  'dell',
  'degl',
  'della',
  'delle',
  'in',
  'nel',
  'nello',
  'nei',
  'negli',
  'nell',
  'negl',
  'nella',
  'nelle',
  'su',
  'sul',
  'sullo',
  'sui',
  'sugli',
  'sull',
  'sugl',
  'sulla',
  'sulle',
  'per',
  'tra',
  'contro',
  'io',
  'tu',
  'lui',
  'lei',
  'noi',
  'voi',
  'loro',
  'mio',
  'mia',
  'miei',
  'mie',
  'tuo',
  'tua',
  'tuoi',
  'tue',
  'suo',
  'sua',
  'suoi',
  'sue',
  'nostro',
  'nostra',
  'nostri',
  'nostre',
  'vostro',
  'vostra',
  'vostri',
  'vostre',
  'mi',
  'ti',
  'ci',
  'vi',
  'lo',
  'la',
  'li',
  'le',
  'gli',
  'ne',
  'il',
  'un',
  'uno',
  'una',
  'ma',
  'ed',
  'se',
  'perch\u00e9',
  'anche',
  'come',
  'dov',
  'dove',
  'che',
  'chi',
  'cui',
  'non',
  'pi\u00f9',
  'quale',
  'quanto',
  'quanti',
  'quanta',
  'quante',
  'quello',
  'quelli',
  'quella',
  'quelle',
  'questo',
  'questi',
  'questa',
  'queste',
  'si',
  'tutto',
  'tutti',
  'a',
  'c',
  'e',
  'i',
  'l',
  'o',
  'ho',
  'hai',
  'ha',
  'abbiamo',
  'avete',
  'hanno',
  'abbia',
  'abbiate',
  'abbiano',
  'avr\u00f2',
  'avrai',
  'avr\u00e0',
  'avremo',
  'avrete',
  'avranno',
  'avrei',
  'avresti',
  'avrebbe',
  'avremmo',
  'avreste',
  'avrebbero',
  'avevo',
  'avevi',
  'aveva',
  'avevamo',
  'avevate',
  'avevano',
  'ebbi',
  'avesti',
  'ebbe',
  'avemmo',
  'aveste',
  'ebbero',
  'avessi',
  'avesse',
  'avessimo',
  'avessero',
  'avendo',
  'avuto',
  'avuta',
  'avuti',
  'avute',
  'sono',
  'sei',
  '\u00e8',
  'siamo',
  'siete',
  'sia',
  'siate',
  'siano',
  'sar\u00f2',
  'sarai',
  'sar\u00e0',
  'saremo',
  'sarete',
  'saranno',
  'sarei',
  'saresti',
  'sarebbe',
  'saremmo',
  'sareste',
  'sarebbero',
  'ero',
  'eri',
  'era',
  'eravamo',
  'eravate',
  'erano',
  'fui',
  'fosti',
  'fu',
  'fummo',
  'foste',
  'furono',
  'fossi',
  'fosse',
  'fossimo',
  'fossero',
  'essendo',
  'faccio',
  'fai',
  'facciamo',
  'fanno',
  'faccia',
  'facciate',
  'facciano',
  'far\u00f2',
  'farai',
  'far\u00e0',
  'faremo',
  'farete',
  'faranno',
  'farei',
  'faresti',
  'farebbe',
  'faremmo',
  'fareste',
  'farebbero',
  'facevo',
  'facevi',
  'faceva',
  'facevamo',
  'facevate',
  'facevano',
  'feci',
  'facesti',
  'fece',
  'facemmo',
  'faceste',
  'fecero',
  'facessi',
  'facesse',
  'facessimo',
  'facessero',
  'facendo',
  'sto',
  'stai',
  'sta',
  'stiamo',
  'stanno',
  'stia',
  'stiate',
  'stiano',
  'star\u00f2',
  'starai',
  'star\u00e0',
  'staremo',
  'starete',
  'staranno',
  'starei',
  'staresti',
  'starebbe',
  'staremmo',
  'stareste',
  'starebbero',
  'stavo',
  'stavi',
  'stava',
  'stavamo',
  'stavate',
  'stavano',
  'stetti',
  'stesti',
  'stette',
  'stemmo',
  'steste',
  'stettero',
  'stessi',
  'stesse',
  'stessimo',
  'stessero',
  'stando',
])

export const italian: LanguageModule = {
  name: 'italian',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9\u00e0\u00e8\u00e9\u00ec\u00f2\u00f3\u00f9'-]+/gi },
}
