import type { LanguageModule } from '../types/language'

const VOWELS = 'aeiou\u00e0\u00e1\u00e2\u00e9\u00ea\u00ed\u00f3\u00f4\u00fa\u00fc'

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

function endsWith(word: string, suffix: string): boolean {
  return word.endsWith(suffix)
}

function suffixInRegion(word: string, suffix: string, regionStart: number): boolean {
  return word.length - suffix.length >= regionStart
}

function removeSuffix(word: string, suffix: string): string {
  return word.slice(0, word.length - suffix.length)
}

function replaceSuffix(word: string, suffix: string, replacement: string): string {
  return word.slice(0, word.length - suffix.length) + replacement
}

/**
 * After nasal normalization (a~ for ã, o~ for õ), the suffix strings
 * need to use the normalized forms. For example:
 *   ação → aça~o, ações → aço~es, ução → uça~o, uções → uço~es
 *   ância → a^ncia (no change since â isn't a nasal tilde)
 *
 * Standard suffix groups for Portuguese (Snowball algorithm):
 *   Group 1 (R2 delete): ica, a^ncia, adora, osa, ista, eza, ante,
 *     a'vel, i'vel, ico, ismo, oso, amento, imento, ador, aça~o, uça~o,
 *     and their plurals
 *   Group 2 (R2 replace with 'log'): logia, logias
 *   Group 3 (R2 replace with 'u'): uça~o, uço~es
 *   Group 4 (R2 replace with 'ente'): e^ncia, e^ncias
 *   Group 5 (R1 delete, sub-deletions in R2): amente
 *   Group 6 (R2 delete, sub-deletions in R2): mente
 *   Group 7 (R2 delete, sub-deletions in R2): idade, idades
 *   Group 8 (R2 delete, optional 'at' in R2): iva, ivo, ivas, ivos
 *   Group 9 (RV, preceding 'e' check): ira, iras
 */

interface SuffixEntry {
  suffix: string
  group: number
}

const STANDARD_SUFFIXES: SuffixEntry[] = [
  { suffix: 'amentos', group: 1 },
  { suffix: 'imentos', group: 1 },
  { suffix: 'adoras', group: 1 },
  { suffix: 'adores', group: 1 },
  { suffix: 'logias', group: 2 },
  { suffix: 'idades', group: 7 },
  { suffix: 'amento', group: 1 },
  { suffix: 'imento', group: 1 },
  { suffix: 'adora', group: 1 },
  { suffix: 'istas', group: 1 },
  { suffix: 'antes', group: 1 },
  { suffix: 'ismos', group: 1 },
  { suffix: '\u00e2ncia', group: 1 },
  { suffix: 'logia', group: 2 },
  { suffix: '\u00eancia', group: 4 },
  { suffix: '\u00eancias', group: 4 },
  { suffix: 'amente', group: 5 },
  { suffix: 'mente', group: 6 },
  { suffix: 'idade', group: 7 },
  { suffix: '\u00e1vel', group: 1 },
  { suffix: '\u00edvel', group: 1 },
  { suffix: 'ador', group: 1 },
  { suffix: 'ante', group: 1 },
  { suffix: 'ista', group: 1 },
  { suffix: 'ismo', group: 1 },
  { suffix: 'icas', group: 1 },
  { suffix: 'icos', group: 1 },
  { suffix: 'osas', group: 1 },
  { suffix: 'osos', group: 1 },
  { suffix: 'iva', group: 8 },
  { suffix: 'ivo', group: 8 },
  { suffix: 'ivas', group: 8 },
  { suffix: 'ivos', group: 8 },
  { suffix: 'ica', group: 1 },
  { suffix: 'ico', group: 1 },
  { suffix: 'osa', group: 1 },
  { suffix: 'oso', group: 1 },
  { suffix: 'ezas', group: 1 },
  { suffix: 'eza', group: 1 },
  { suffix: 'ira', group: 9 },
  { suffix: 'iras', group: 9 },
  { suffix: 'a\u00e7a~o', group: 1 },
  { suffix: 'u\u00e7a~o', group: 3 },
  { suffix: 'a\u00e7o~es', group: 1 },
  { suffix: 'u\u00e7o~es', group: 3 },
]

function findLongestMatch(word: string, suffixes: SuffixEntry[]): SuffixEntry | null {
  let best: SuffixEntry | null = null
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
  const match = findLongestMatch(word, STANDARD_SUFFIXES)
  if (match === null) return { word, changed: false }

  const { suffix, group } = match

  if (group === 1) {
    if (!suffixInRegion(word, suffix, r2)) return { word, changed: false }
    return { word: removeSuffix(word, suffix), changed: true }
  }

  if (group === 2) {
    if (!suffixInRegion(word, suffix, r2)) return { word, changed: false }
    return { word: replaceSuffix(word, suffix, 'log'), changed: true }
  }

  if (group === 3) {
    if (!suffixInRegion(word, suffix, r2)) return { word, changed: false }
    return { word: replaceSuffix(word, suffix, 'u'), changed: true }
  }

  if (group === 4) {
    if (!suffixInRegion(word, suffix, r2)) return { word, changed: false }
    return { word: replaceSuffix(word, suffix, 'ente'), changed: true }
  }

  if (group === 5) {
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
    } else if (endsWith(word, 'ad') && suffixInRegion(word, 'ad', r2)) {
      word = removeSuffix(word, 'ad')
    }
    return { word, changed: true }
  }

  if (group === 6) {
    if (!suffixInRegion(word, suffix, r2)) return { word, changed: false }
    word = removeSuffix(word, suffix)
    if (endsWith(word, 'ante') && suffixInRegion(word, 'ante', r2)) {
      word = removeSuffix(word, 'ante')
    } else if (endsWith(word, 'avel') && suffixInRegion(word, 'avel', r2)) {
      word = removeSuffix(word, 'avel')
    } else if (endsWith(word, '\u00edvel') && suffixInRegion(word, '\u00edvel', r2)) {
      word = removeSuffix(word, '\u00edvel')
    }
    return { word, changed: true }
  }

  if (group === 7) {
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

  if (group === 8) {
    if (!suffixInRegion(word, suffix, r2)) return { word, changed: false }
    word = removeSuffix(word, suffix)
    if (endsWith(word, 'at') && suffixInRegion(word, 'at', r2)) {
      word = removeSuffix(word, 'at')
    }
    return { word, changed: true }
  }

  if (group === 9) {
    if (!suffixInRegion(word, suffix, rv)) return { word, changed: false }
    const withoutSuffix = removeSuffix(word, suffix)
    if (endsWith(withoutSuffix, 'e')) {
      return { word: replaceSuffix(word, suffix, 'ir'), changed: true }
    }
    return { word, changed: false }
  }

  return { word, changed: false }
}

const VERB_SUFFIXES = [
  'ar\u00edamos',
  'er\u00edamos',
  'ir\u00edamos',
  '\u00e1ssemos',
  '\u00eassemos',
  '\u00edssemos',
  '\u00e1ramos',
  '\u00e9ramos',
  '\u00edramos',
  '\u00e1vamos',
  '\u00edamos',
  'aremos',
  'eremos',
  'iremos',
  'ar\u00edeis',
  'er\u00edeis',
  'ir\u00edeis',
  '\u00e1sseis',
  '\u00e9sseis',
  '\u00edsseis',
  '\u00e1veis',
  '\u00edeis',
  'ardes',
  'erdes',
  'irdes',
  'areis',
  'ereis',
  'ireis',
  '\u00e1reis',
  '\u00e9reis',
  '\u00edreis',
  'asses',
  'esses',
  'isses',
  'astes',
  'estes',
  'istes',
  'ariam',
  'eriam',
  'iriam',
  'arias',
  'erias',
  'irias',
  'assem',
  'essem',
  'issem',
  'armos',
  'ermos',
  'irmos',
  'aram',
  'eram',
  'iram',
  'avam',
  'arem',
  'erem',
  'irem',
  'ando',
  'endo',
  'indo',
  'ados',
  'idos',
  'amos',
  'emos',
  'imos',
  'ar\u00e1s',
  'er\u00e1s',
  'ir\u00e1s',
  'ares',
  'eres',
  'ires',
  'avas',
  'aria',
  'eria',
  'iria',
  'asse',
  'esse',
  'isse',
  'aste',
  'este',
  'iste',
  'arei',
  'erei',
  'irei',
  'ada',
  'ida',
  'ara',
  'era',
  'ira',
  'ava',
  'ado',
  'ido',
  'ais',
  'eis',
  'is',
  'iam',
  '\u00e1mos',
  'ara~o',
  'era~o',
  'ira~o',
  'am',
  'em',
  'ar',
  'er',
  'ir',
  'as',
  'es',
  'eu',
  'iu',
  'ou',
  'ia',
  'ei',
  'ar\u00e1',
  'er\u00e1',
  'ir\u00e1',
]

function removeVerbSuffix(word: string, rv: number): { word: string; changed: boolean } {
  let longestSuffix: string | null = null
  for (const suffix of VERB_SUFFIXES) {
    if (endsWith(word, suffix) && suffixInRegion(word, suffix, rv)) {
      if (longestSuffix === null || suffix.length > longestSuffix.length) {
        longestSuffix = suffix
      }
    }
  }

  if (longestSuffix !== null) {
    return { word: removeSuffix(word, longestSuffix), changed: true }
  }

  return { word, changed: false }
}

const RESIDUAL_SUFFIXES = ['a', 'i', 'o', 'os', '\u00e1', '\u00ed', '\u00f3']

function removeResidualSuffix(word: string, rv: number): { word: string; changed: boolean } {
  let longestSuffix: string | null = null
  for (const suffix of RESIDUAL_SUFFIXES) {
    if (endsWith(word, suffix) && suffixInRegion(word, suffix, rv)) {
      if (longestSuffix === null || suffix.length > longestSuffix.length) {
        longestSuffix = suffix
      }
    }
  }

  if (longestSuffix !== null) {
    return { word: removeSuffix(word, longestSuffix), changed: true }
  }

  return { word, changed: false }
}

function removeResidualForm(word: string, rv: number): string {
  if (endsWith(word, '\u00ea') && suffixInRegion(word, '\u00ea', rv)) {
    return removeSuffix(word, '\u00ea')
  }

  if (endsWith(word, '\u00e9') && suffixInRegion(word, '\u00e9', rv)) {
    return removeSuffix(word, '\u00e9')
  }

  if (endsWith(word, 'e') && suffixInRegion(word, 'e', rv)) {
    word = removeSuffix(word, 'e')
    if (endsWith(word, 'gu') && suffixInRegion(word, 'u', rv)) {
      word = removeSuffix(word, 'u')
    } else if (endsWith(word, 'ci') && suffixInRegion(word, 'i', rv)) {
      word = removeSuffix(word, 'i')
    }
    return word
  }

  if (endsWith(word, '\u00e7')) {
    return replaceSuffix(word, '\u00e7', 'c')
  }

  return word
}

function normalizeNasals(word: string): string {
  return word.replace(/\u00e3/g, 'a~').replace(/\u00f5/g, 'o~')
}

function restoreNasals(word: string): string {
  return word.replace(/a~/g, '\u00e3').replace(/o~/g, '\u00f5')
}

function stem(word: string): string {
  if (word.length < 3) return word

  word = word.toLowerCase()
  word = normalizeNasals(word)

  const { rv, r1, r2 } = findRegions(word)

  const standardResult = removeStandardSuffix(word, r1, r2, rv)
  let standardOrVerbChanged = standardResult.changed

  if (standardResult.changed) {
    word = standardResult.word
  } else {
    const verbResult = removeVerbSuffix(word, rv)
    standardOrVerbChanged = verbResult.changed
    word = verbResult.word
  }

  if (standardOrVerbChanged) {
    if (endsWith(word, 'i') && suffixInRegion(word, 'i', rv)) {
      const preceding = word.length >= 2 ? word[word.length - 2] : ''
      if (preceding === 'c') {
        word = removeSuffix(word, 'i')
      }
    }
  } else {
    const residualResult = removeResidualSuffix(word, rv)
    word = residualResult.word
  }

  word = removeResidualForm(word, rv)
  word = restoreNasals(word)

  return word
}

const stopWords = new Set([
  'de',
  'a',
  'o',
  'que',
  'e',
  'do',
  'da',
  'em',
  'um',
  'para',
  'com',
  'n\u00e3o',
  'uma',
  'os',
  'no',
  'se',
  'na',
  'por',
  'mais',
  'as',
  'dos',
  'como',
  'mas',
  'ao',
  'ele',
  'das',
  '\u00e0',
  'seu',
  'sua',
  'ou',
  'quando',
  'muito',
  'nos',
  'j\u00e1',
  'eu',
  'tamb\u00e9m',
  's\u00f3',
  'pelo',
  'pela',
  'at\u00e9',
  'isso',
  'ela',
  'entre',
  'depois',
  'sem',
  'mesmo',
  'aos',
  'seus',
  'quem',
  'nas',
  'me',
  'esse',
  'eles',
  'voc\u00ea',
  'essa',
  'num',
  'nem',
  'suas',
  'meu',
  '\u00e0s',
  'minha',
  'numa',
  'pelos',
  'elas',
  'qual',
  'n\u00f3s',
  'lhe',
  'deles',
  'essas',
  'esses',
  'pelas',
  'este',
  'dele',
  'tu',
  'te',
  'voc\u00eas',
  'vos',
  'lhes',
  'meus',
  'minhas',
  'teu',
  'tua',
  'teus',
  'tuas',
  'nosso',
  'nossa',
  'nossos',
  'nossas',
  'dela',
  'delas',
  'esta',
  'estes',
  'estas',
  'aquele',
  'aquela',
  'aqueles',
  'aquelas',
  'isto',
  'aquilo',
  'estou',
  'est\u00e1',
  'estamos',
  'est\u00e3o',
  'estive',
  'esteve',
  'estivemos',
  'estiveram',
  'estava',
  'est\u00e1vamos',
  'estavam',
  'estivera',
  'estiv\u00e9ramos',
  'esteja',
  'estejamos',
  'estejam',
  'estivesse',
  'estiv\u00e9ssemos',
  'estivessem',
  'estiver',
  'estivermos',
  'estiverem',
  'hei',
  'h\u00e1',
  'havemos',
  'h\u00e3o',
  'houve',
  'houvemos',
  'houveram',
  'houvera',
  'houv\u00e9ramos',
  'haja',
  'hajamos',
  'hajam',
  'houvesse',
  'houv\u00e9ssemos',
  'houvessem',
  'houver',
  'houvermos',
  'houverem',
  'houverei',
  'houver\u00e1',
  'houveremos',
  'houver\u00e3o',
  'houveria',
  'houver\u00edamos',
  'houveriam',
  'sou',
  'somos',
  's\u00e3o',
  'era',
  '\u00e9ramos',
  'eram',
  'fui',
  'foi',
  'fomos',
  'foram',
  'fora',
  'f\u00f4ramos',
  'seja',
  'sejamos',
  'sejam',
  'fosse',
  'f\u00f4ssemos',
  'fossem',
  'for',
  'formos',
  'forem',
  'serei',
  'ser\u00e1',
  'seremos',
  'ser\u00e3o',
  'seria',
  'ser\u00edamos',
  'seriam',
  'tenho',
  'tem',
  'temos',
  't\u00e9m',
  'tinha',
  't\u00ednhamos',
  'tinham',
  'tive',
  'teve',
  'tivemos',
  'tiveram',
  'tivera',
  'tiv\u00e9ramos',
  'tenha',
  'tenhamos',
  'tenham',
  'tivesse',
  'tiv\u00e9ssemos',
  'tivessem',
  'tiver',
  'tivermos',
  'tiverem',
  'terei',
  'ter\u00e1',
  'teremos',
  'ter\u00e3o',
  'teria',
  'ter\u00edamos',
  'teriam',
])

export const portuguese: LanguageModule = {
  name: 'portuguese',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9\u00e0-\u00fa]+/gi },
}
