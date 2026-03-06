import type { LanguageModule } from '../types/language'

const VOWELS = 'aeiouáéíóúü'

const ACCENT_A = /á/g
const ACCENT_E = /é/g
const ACCENT_I = /í/g
const ACCENT_O = /ó/g
const ACCENT_U = /ú/g

const STEP1_GROUP1_SUFFIXES = [
  'amientos',
  'imientos',
  'amiento',
  'imiento',
  'aciones',
  'uciones',
  'adoras',
  'adores',
  'ancias',
  'encias',
  'adora',
  'antes',
  'anzas',
  'ismos',
  'istas',
  'ables',
  'ibles',
  'ación',
  'ución',
  'icas',
  'ador',
  'ante',
  'anza',
  'icos',
  'ismo',
  'ista',
  'osas',
  'osos',
  'iva',
  'ivo',
  'ivas',
  'ivos',
  'ica',
  'ico',
  'osa',
  'oso',
  'able',
  'ible',
]

const STEP1_GROUP2_SUFFIXES = ['logías', 'logía']
const STEP1_GROUP3_SUFFIXES = ['ución', 'uciones']
const STEP1_GROUP4_SUFFIXES = ['encia', 'encias']
const STEP1_GROUP5_SUFFIXES = ['amente']
const STEP1_GROUP6_SUFFIXES = ['mente']
const STEP1_GROUP7_SUFFIXES = ['idades', 'idad']

const STEP1_ALL_SUFFIXES: string[] = [
  ...STEP1_GROUP1_SUFFIXES,
  ...STEP1_GROUP2_SUFFIXES,
  ...STEP1_GROUP3_SUFFIXES,
  ...STEP1_GROUP4_SUFFIXES,
  ...STEP1_GROUP5_SUFFIXES,
  ...STEP1_GROUP6_SUFFIXES,
  ...STEP1_GROUP7_SUFFIXES,
]

const Y_VERB_SUFFIXES = ['yeron', 'yendo', 'yamos', 'yais', 'yan', 'yen', 'yas', 'yes', 'ya', 'ye', 'yo', 'yó']

const STEP2B_VERB_SUFFIXES = [
  'iéramos',
  'iésemos',
  'eríamos',
  'aríamos',
  'iríamos',
  'áramos',
  'ábamos',
  'ásemos',
  'íamos',
  'aríais',
  'eríais',
  'iríais',
  'ieran',
  'iesen',
  'ieron',
  'irían',
  'erían',
  'arían',
  'arais',
  'aseis',
  'eréis',
  'aréis',
  'iréis',
  'irías',
  'erías',
  'arías',
  'ieras',
  'ieses',
  'abais',
  'aremos',
  'eremos',
  'iremos',
  'isteis',
  'asteis',
  'ierais',
  'ieseis',
  'iendo',
  'ando',
  'arán',
  'erán',
  'irán',
  'aron',
  'aban',
  'aran',
  'adas',
  'idas',
  'abas',
  'aras',
  'ases',
  'iría',
  'ería',
  'aría',
  'iera',
  'iese',
  'aste',
  'iste',
  'ados',
  'idos',
  'amos',
  'imos',
  'ían',
  'áis',
  'aba',
  'ada',
  'ida',
  'ara',
  'ase',
  'ado',
  'ido',
  'ías',
  'éis',
  'ía',
  'ad',
  'ed',
  'id',
  'an',
  'ió',
  'ar',
  'er',
  'ir',
  'as',
  'es',
  'ís',
  'en',
  'ará',
  'erá',
  'irá',
  'aré',
  'eré',
  'iré',
  'át',
]

const RESIDUAL_SUFFIXES = ['os', 'a', 'o', 'á', 'í', 'ó']

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch)
}

function findRegions(word: string): { rv: number; r1: number; r2: number } {
  let rv = word.length
  let r1 = word.length
  let r2 = word.length

  /**
   * RV for Spanish:
   * If the second letter is a consonant, RV is the region after the next vowel.
   * If the first two letters are vowels, RV is the region after the next consonant.
   * If the first letter is a consonant and the second is a vowel, RV is the region
   * after the third letter. Otherwise, RV is the end of the word.
   */
  if (word.length >= 2) {
    if (!isVowel(word[1])) {
      for (let i = 2; i < word.length; i++) {
        if (isVowel(word[i])) {
          rv = i + 1
          break
        }
      }
    } else if (isVowel(word[0])) {
      for (let i = 2; i < word.length; i++) {
        if (!isVowel(word[i])) {
          rv = i + 1
          break
        }
      }
    } else {
      rv = 3
    }
  }

  for (let i = 0; i < word.length - 1; i++) {
    if (isVowel(word[i]) && !isVowel(word[i + 1])) {
      r1 = i + 2
      break
    }
  }

  for (let i = r1; i < word.length - 1; i++) {
    if (isVowel(word[i]) && !isVowel(word[i + 1])) {
      r2 = i + 2
      break
    }
  }

  return { rv, r1, r2 }
}

function endsWith(word: string, suffix: string): boolean {
  return word.endsWith(suffix)
}

function removeSuffix(word: string, suffix: string): string {
  return word.slice(0, word.length - suffix.length)
}

function suffixInRegion(word: string, suffix: string, regionStart: number): boolean {
  return word.length - suffix.length >= regionStart
}

function findLongestAmong(word: string, suffixes: string[], regionStart: number): string | null {
  let longestMatch: string | null = null
  for (const suffix of suffixes) {
    if (endsWith(word, suffix) && suffixInRegion(word, suffix, regionStart)) {
      if (longestMatch === null || suffix.length > longestMatch.length) {
        longestMatch = suffix
      }
    }
  }
  return longestMatch
}

function removeAccents(word: string): string {
  return word
    .replace(ACCENT_A, 'a')
    .replace(ACCENT_E, 'e')
    .replace(ACCENT_I, 'i')
    .replace(ACCENT_O, 'o')
    .replace(ACCENT_U, 'u')
}

const ATTACHED_PRONOUNS = ['selas', 'selos', 'sela', 'selo', 'las', 'les', 'los', 'nos', 'la', 'le', 'lo', 'me', 'se']

const PRONOUN_VERB_SUFFIXES = ['iéndo', 'ándo', 'ár', 'ér', 'ír', 'iendo', 'ando', 'yendo', 'ar', 'er', 'ir']

function step0AttachedPronoun(word: string, rv: number): string {
  for (const pronoun of ATTACHED_PRONOUNS) {
    if (!endsWith(word, pronoun)) continue
    if (!suffixInRegion(word, pronoun, rv)) continue

    const beforePronoun = removeSuffix(word, pronoun)

    for (const verbSuffix of PRONOUN_VERB_SUFFIXES) {
      if (!endsWith(beforePronoun, verbSuffix)) continue

      if (verbSuffix === 'yendo' && endsWith(removeSuffix(beforePronoun, 'yendo'), 'u')) {
        return removeSuffix(word, pronoun)
      }

      if (verbSuffix === 'iéndo') {
        return `${removeSuffix(word, pronoun).slice(0, -5)}iendo`
      }
      if (verbSuffix === 'ándo') {
        return `${removeSuffix(word, pronoun).slice(0, -4)}ando`
      }
      if (verbSuffix === 'ár') {
        return `${removeSuffix(word, pronoun).slice(0, -2)}ar`
      }
      if (verbSuffix === 'ér') {
        return `${removeSuffix(word, pronoun).slice(0, -2)}er`
      }
      if (verbSuffix === 'ír') {
        return `${removeSuffix(word, pronoun).slice(0, -2)}ir`
      }

      return removeSuffix(word, pronoun)
    }
  }
  return word
}

function step1StandardSuffix(word: string, r1: number, r2: number): { word: string; changed: boolean } {
  let longestSuffix: string | null = null
  for (const s of STEP1_ALL_SUFFIXES) {
    if (endsWith(word, s)) {
      if (longestSuffix === null || s.length > longestSuffix.length) {
        longestSuffix = s
      }
    }
  }

  if (!longestSuffix) return { word, changed: false }

  if (STEP1_GROUP1_SUFFIXES.includes(longestSuffix)) {
    if (longestSuffix === 'iva' || longestSuffix === 'ivo' || longestSuffix === 'ivas' || longestSuffix === 'ivos') {
      if (!suffixInRegion(word, longestSuffix, r2)) return { word, changed: false }
      word = removeSuffix(word, longestSuffix)
      if (endsWith(word, 'at') && suffixInRegion(word, 'at', r2)) {
        word = removeSuffix(word, 'at')
      }
      return { word, changed: true }
    }
    if (!suffixInRegion(word, longestSuffix, r2)) return { word, changed: false }
    return { word: removeSuffix(word, longestSuffix), changed: true }
  }

  if (STEP1_GROUP2_SUFFIXES.includes(longestSuffix)) {
    if (!suffixInRegion(word, longestSuffix, r2)) return { word, changed: false }
    return { word: `${removeSuffix(word, longestSuffix)}log`, changed: true }
  }

  if (STEP1_GROUP3_SUFFIXES.includes(longestSuffix)) {
    if (!suffixInRegion(word, longestSuffix, r2)) return { word, changed: false }
    return { word: `${removeSuffix(word, longestSuffix)}u`, changed: true }
  }

  if (STEP1_GROUP4_SUFFIXES.includes(longestSuffix)) {
    if (!suffixInRegion(word, longestSuffix, r2)) return { word, changed: false }
    return { word: `${removeSuffix(word, longestSuffix)}ente`, changed: true }
  }

  if (STEP1_GROUP5_SUFFIXES.includes(longestSuffix)) {
    if (!suffixInRegion(word, longestSuffix, r1)) return { word, changed: false }
    word = removeSuffix(word, longestSuffix)
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

  if (STEP1_GROUP6_SUFFIXES.includes(longestSuffix)) {
    if (!suffixInRegion(word, longestSuffix, r2)) return { word, changed: false }
    word = removeSuffix(word, longestSuffix)
    if (endsWith(word, 'ante') && suffixInRegion(word, 'ante', r2)) {
      word = removeSuffix(word, 'ante')
    } else if (endsWith(word, 'able') && suffixInRegion(word, 'able', r2)) {
      word = removeSuffix(word, 'able')
    } else if (endsWith(word, 'ible') && suffixInRegion(word, 'ible', r2)) {
      word = removeSuffix(word, 'ible')
    }
    return { word, changed: true }
  }

  if (STEP1_GROUP7_SUFFIXES.includes(longestSuffix)) {
    if (!suffixInRegion(word, longestSuffix, r2)) return { word, changed: false }
    word = removeSuffix(word, longestSuffix)
    if (endsWith(word, 'abil') && suffixInRegion(word, 'abil', r2)) {
      word = removeSuffix(word, 'abil')
    } else if (endsWith(word, 'ic') && suffixInRegion(word, 'ic', r2)) {
      word = removeSuffix(word, 'ic')
    } else if (endsWith(word, 'iv') && suffixInRegion(word, 'iv', r2)) {
      word = removeSuffix(word, 'iv')
    }
    return { word, changed: true }
  }

  return { word, changed: false }
}

function step2aYVerbSuffix(word: string, rv: number): { word: string; changed: boolean } {
  const suffix = findLongestAmong(word, Y_VERB_SUFFIXES, rv)
  if (suffix) {
    const stemmed = removeSuffix(word, suffix)
    if (stemmed.length > 0 && stemmed[stemmed.length - 1] === 'u') {
      return { word: stemmed, changed: true }
    }
  }
  return { word, changed: false }
}

function step2bVerbSuffix(word: string, rv: number): { word: string; changed: boolean } {
  const suffix = findLongestAmong(word, STEP2B_VERB_SUFFIXES, rv)
  if (!suffix) return { word, changed: false }

  if (suffix === 'en' || suffix === 'es' || suffix === 'éis' || suffix === 'emos') {
    word = removeSuffix(word, suffix)
    if (endsWith(word, 'gu')) {
      if (suffixInRegion(word, 'u', rv)) {
        word = removeSuffix(word, 'u')
      }
    }
    return { word, changed: true }
  }

  return { word: removeSuffix(word, suffix), changed: true }
}

function step3ResidualSuffix(word: string, rv: number): string {
  const suffix = findLongestAmong(word, RESIDUAL_SUFFIXES, rv)
  if (suffix) {
    return removeSuffix(word, suffix)
  }

  if (endsWith(word, 'e') || endsWith(word, 'é')) {
    const eSuffix = endsWith(word, 'é') ? 'é' : 'e'
    if (suffixInRegion(word, eSuffix, rv)) {
      word = removeSuffix(word, eSuffix)
      if (endsWith(word, 'gu') && suffixInRegion(word, 'u', rv)) {
        word = removeSuffix(word, 'u')
      }
      return word
    }
  }

  return word
}

function stem(word: string): string {
  if (word.length < 3) return word

  const { rv, r1, r2 } = findRegions(word)

  word = step0AttachedPronoun(word, rv)

  const step1Result = step1StandardSuffix(word, r1, r2)
  let stemChanged = step1Result.changed
  word = step1Result.word

  if (!stemChanged) {
    const step2aResult = step2aYVerbSuffix(word, rv)
    if (step2aResult.changed) {
      word = step2aResult.word
      stemChanged = true
    } else {
      const step2bResult = step2bVerbSuffix(word, rv)
      word = step2bResult.word
      stemChanged = step2bResult.changed
    }
  }

  word = step3ResidualSuffix(word, rv)
  word = removeAccents(word)

  return word
}

const stopWords = new Set([
  'a',
  'al',
  'algo',
  'alguna',
  'algunas',
  'alguno',
  'algunos',
  'algún',
  'ambos',
  'ante',
  'antes',
  'aquel',
  'aquella',
  'aquellas',
  'aquello',
  'aquellos',
  'aquí',
  'arriba',
  'así',
  'aunque',
  'aún',
  'bajo',
  'bastante',
  'bien',
  'cada',
  'casi',
  'como',
  'con',
  'contra',
  'cual',
  'cuales',
  'cuando',
  'cuándo',
  'cuánto',
  'cuántos',
  'de',
  'del',
  'demás',
  'dentro',
  'desde',
  'donde',
  'dónde',
  'dos',
  'durante',
  'el',
  'ella',
  'ellas',
  'ello',
  'ellos',
  'en',
  'encima',
  'entonces',
  'entre',
  'era',
  'esa',
  'esas',
  'ese',
  'eso',
  'esos',
  'esta',
  'estaba',
  'estado',
  'estas',
  'este',
  'esto',
  'estos',
  'está',
  'están',
  'fue',
  'fuera',
  'fueron',
  'ha',
  'hace',
  'hacen',
  'hacer',
  'hacia',
  'han',
  'hasta',
  'hay',
  'la',
  'las',
  'le',
  'les',
  'lo',
  'los',
  'luego',
  'mas',
  'más',
  'me',
  'mejor',
  'menos',
  'mi',
  'mientras',
  'mis',
  'misma',
  'mismo',
  'mucha',
  'muchas',
  'mucho',
  'muchos',
  'muy',
  'mí',
  'mía',
  'mío',
  'nada',
  'ni',
  'ninguna',
  'ninguno',
  'ningún',
  'no',
  'nos',
  'nosotras',
  'nosotros',
  'nuestra',
  'nuestras',
  'nuestro',
  'nuestros',
  'nunca',
  'o',
  'os',
  'otra',
  'otras',
  'otro',
  'otros',
  'para',
  'pero',
  'poca',
  'pocas',
  'poco',
  'pocos',
  'por',
  'porque',
  'que',
  'qué',
  'quien',
  'quién',
  'se',
  'sea',
  'según',
  'ser',
  'será',
  'si',
  'sido',
  'sin',
  'sino',
  'sobre',
  'somos',
  'son',
  'soy',
  'su',
  'sus',
  'suya',
  'suyas',
  'suyo',
  'sí',
  'también',
  'tan',
  'tanto',
  'te',
  'tengo',
  'ti',
  'tiene',
  'tienen',
  'toda',
  'todas',
  'todavía',
  'todo',
  'todos',
  'tu',
  'tus',
  'tuya',
  'tuyo',
  'tú',
  'un',
  'una',
  'unas',
  'uno',
  'unos',
  'usted',
  'ustedes',
  'va',
  'vamos',
  'ver',
  'vez',
  'vosotras',
  'vosotros',
  'vuestra',
  'vuestras',
  'vuestro',
  'vuestros',
  'y',
  'ya',
  'yo',
  'él',
  'ésta',
  'éstas',
  'éste',
  'éstos',
  'última',
  'últimas',
  'último',
  'últimos',
])

export const spanish: LanguageModule = {
  name: 'spanish',
  stemmer: stem,
  stopWords,
  tokenizer: {
    splitPattern: /[^a-z0-9á-úñü]+/gi,
  },
}
