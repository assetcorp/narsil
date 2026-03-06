import type { LanguageModule } from '../types/language'

const VOWELS = 'aeiouyäö'
const LONG_VOWELS = ['aa', 'ee', 'ii', 'oo', 'uu', 'ää', 'öö']
const CONSONANT_PATTERN = /[a-zäö]/

const PARTICLES = ['kaan', 'kään', 'han', 'hän', 'kin', 'ko', 'kö', 'pa', 'pä']

const BACK_VOWEL_ENDINGS = ['lla', 'na', 'ssa', 'ta', 'lta', 'sta']
const FRONT_VOWEL_ENDINGS = ['llä', 'nä', 'ssä', 'tä', 'ltä', 'stä']
const NEUTRAL_ENDINGS = ['lle', 'ine']

const H_SUFFIXES: ReadonlyArray<{ suffix: string; requiredPreceding: string }> = [
  { suffix: 'han', requiredPreceding: 'a' },
  { suffix: 'hen', requiredPreceding: 'e' },
  { suffix: 'hin', requiredPreceding: 'i' },
  { suffix: 'hon', requiredPreceding: 'o' },
  { suffix: 'hun', requiredPreceding: 'u' },
  { suffix: 'hyn', requiredPreceding: 'y' },
  { suffix: 'hän', requiredPreceding: 'ä' },
  { suffix: 'hön', requiredPreceding: 'ö' },
]
const SIMPLE_SUFFIXES = ['ssa', 'ssä', 'sta', 'stä', 'lla', 'llä', 'lta', 'ltä', 'lle', 'ine', 'ksi']

const STEP4_SUFFIXES: ReadonlyArray<{ text: string; checkPo: boolean }> = [
  { text: 'impa', checkPo: false },
  { text: 'impä', checkPo: false },
  { text: 'impi', checkPo: true },
  { text: 'imma', checkPo: false },
  { text: 'immä', checkPo: false },
  { text: 'immi', checkPo: true },
  { text: 'eja', checkPo: false },
  { text: 'ejä', checkPo: false },
  { text: 'mpa', checkPo: false },
  { text: 'mpä', checkPo: false },
  { text: 'mpi', checkPo: true },
  { text: 'mma', checkPo: false },
  { text: 'mmä', checkPo: false },
  { text: 'mmi', checkPo: true },
]

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch)
}

function isConsonant(ch: string): boolean {
  return ch.length === 1 && !isVowel(ch) && CONSONANT_PATTERN.test(ch)
}

function endsWithLongVowel(word: string): boolean {
  if (word.length < 2) return false
  const tail = word.slice(-2)
  return LONG_VOWELS.includes(tail)
}

function computeRegions(word: string): { r1: number; r2: number } {
  let r1 = word.length
  let r2 = word.length
  let foundVowel = false

  for (let i = 0; i < word.length; i++) {
    if (foundVowel && !isVowel(word[i])) {
      r1 = i + 1
      break
    }
    if (isVowel(word[i])) {
      foundVowel = true
    }
  }

  foundVowel = false
  for (let i = r1; i < word.length; i++) {
    if (foundVowel && !isVowel(word[i])) {
      r2 = i + 1
      break
    }
    if (isVowel(word[i])) {
      foundVowel = true
    }
  }

  return { r1, r2 }
}

function suffixInR1(word: string, suffix: string, r1: number): boolean {
  return word.endsWith(suffix) && word.length - suffix.length >= r1
}

function suffixInR2(word: string, suffix: string, r2: number): boolean {
  return word.endsWith(suffix) && word.length - suffix.length >= r2
}

/**
 * Step 1: Remove particles from R1.
 * Particles: kaan, kään, ko, kö, han, hän, pa, pä, kin.
 * The particle is only removed if preceded by a vowel or 'n'.
 * The 'sti' suffix is removed from R2.
 */
function step1(word: string, r1: number, r2: number): string {
  for (const p of PARTICLES) {
    if (suffixInR1(word, p, r1)) {
      const charBefore = word[word.length - p.length - 1]
      if (charBefore && (isVowel(charBefore) || charBefore === 'n')) {
        return word.slice(0, -p.length)
      }
    }
  }

  if (suffixInR2(word, 'sti', r2)) {
    return word.slice(0, -3)
  }

  return word
}

/**
 * Step 2: Remove possessive suffixes from R1.
 * Handles: si, ni, nsa, nsä, mme, nne, and conditional suffixes an, en, än.
 */
function step2(word: string, r1: number): string {
  if (suffixInR1(word, 'nsa', r1)) return word.slice(0, -3)
  if (suffixInR1(word, 'nsä', r1)) return word.slice(0, -3)
  if (suffixInR1(word, 'mme', r1)) return word.slice(0, -3)
  if (suffixInR1(word, 'nne', r1)) return word.slice(0, -3)

  if (suffixInR1(word, 'si', r1)) {
    const base = word.slice(0, -2)
    if (base.endsWith('k')) return base
    if (base.endsWith('kse')) return `${base.slice(0, -3)}ksi`
    return base
  }

  if (suffixInR1(word, 'ni', r1)) {
    const base = word.slice(0, -2)
    if (base.endsWith('kse')) return `${base.slice(0, -3)}ksi`
    return base
  }

  if (suffixInR1(word, 'an', r1)) {
    const base = word.slice(0, -2)
    for (const ending of BACK_VOWEL_ENDINGS) {
      if (base.endsWith(ending)) return base
    }
  }

  if (suffixInR1(word, 'än', r1)) {
    const base = word.slice(0, -2)
    for (const ending of FRONT_VOWEL_ENDINGS) {
      if (base.endsWith(ending)) return base
    }
  }

  if (suffixInR1(word, 'en', r1)) {
    const base = word.slice(0, -2)
    for (const ending of NEUTRAL_ENDINGS) {
      if (base.endsWith(ending)) return base
    }
  }

  return word
}

/**
 * Step 3: Remove case endings from R1.
 * Returns the modified word and a flag indicating whether a case ending was removed.
 */
function step3(word: string, r1: number): { word: string; caseRemoved: boolean } {
  for (const { suffix, requiredPreceding } of H_SUFFIXES) {
    if (suffixInR1(word, suffix, r1)) {
      const base = word.slice(0, -suffix.length)
      if (base.length > 0 && base[base.length - 1] === requiredPreceding) {
        return { word: base, caseRemoved: true }
      }
    }
  }

  if (suffixInR1(word, 'siin', r1)) {
    const base = word.slice(0, -4)
    if (base.length >= 2 && isConsonant(base[base.length - 1])) {
      return { word: base, caseRemoved: true }
    }
  }

  if (suffixInR1(word, 'seen', r1)) {
    const base = word.slice(0, -4)
    if (endsWithLongVowel(base)) {
      return { word: base, caseRemoved: true }
    }
  }

  if (suffixInR1(word, 'den', r1)) {
    const base = word.slice(0, -3)
    if (base.length >= 2 && isConsonant(base[base.length - 1])) {
      return { word: base, caseRemoved: true }
    }
  }

  if (suffixInR1(word, 'tten', r1)) {
    const base = word.slice(0, -4)
    if (base.length >= 2 && isConsonant(base[base.length - 1])) {
      return { word: base, caseRemoved: true }
    }
  }

  for (const suffix of SIMPLE_SUFFIXES) {
    if (suffixInR1(word, suffix, r1)) {
      return { word: word.slice(0, -suffix.length), caseRemoved: true }
    }
  }

  if (suffixInR1(word, 'na', r1)) return { word: word.slice(0, -2), caseRemoved: true }
  if (suffixInR1(word, 'nä', r1)) return { word: word.slice(0, -2), caseRemoved: true }

  if (suffixInR1(word, 'tta', r1)) {
    const base = word.slice(0, -3)
    if (base.length > 0 && isVowel(base[base.length - 1])) {
      return { word: base, caseRemoved: true }
    }
  }
  if (suffixInR1(word, 'ttä', r1)) {
    const base = word.slice(0, -3)
    if (base.length > 0 && isVowel(base[base.length - 1])) {
      return { word: base, caseRemoved: true }
    }
  }

  if (suffixInR1(word, 'ta', r1)) return { word: word.slice(0, -2), caseRemoved: true }
  if (suffixInR1(word, 'tä', r1)) return { word: word.slice(0, -2), caseRemoved: true }

  if (suffixInR1(word, 'n', r1)) {
    const base = word.slice(0, -1)
    if (endsWithLongVowel(base)) {
      return { word: base.slice(0, -1), caseRemoved: true }
    }
    if (base.endsWith('ie')) {
      return { word: base, caseRemoved: true }
    }
    if (base.length > 0 && isVowel(base[base.length - 1]) && isConsonant(base[base.length - 2])) {
      return { word: base, caseRemoved: true }
    }
  }

  if (suffixInR1(word, 'a', r1)) {
    const base = word.slice(0, -1)
    if (base.length >= 2 && isVowel(base[base.length - 1]) && isConsonant(base[base.length - 2])) {
      return { word: base, caseRemoved: true }
    }
  }
  if (suffixInR1(word, 'ä', r1)) {
    const base = word.slice(0, -1)
    if (base.length >= 2 && isVowel(base[base.length - 1]) && isConsonant(base[base.length - 2])) {
      return { word: base, caseRemoved: true }
    }
  }

  return { word, caseRemoved: false }
}

/**
 * Step 4: Remove comparative/superlative suffixes from R2.
 * Suffixes ending in 'i' (mpi, mmi, impi, immi) require the base not to end in 'po'.
 */
function step4(word: string, r2: number): string {
  for (const { text, checkPo } of STEP4_SUFFIXES) {
    if (suffixInR2(word, text, r2)) {
      if (checkPo) {
        const base = word.slice(0, -text.length)
        if (base.endsWith('po')) continue
      }
      return word.slice(0, -text.length)
    }
  }

  return word
}

/**
 * Step 5: Handle 'i' and 'j' suffixes when a case ending was removed.
 */
function step5(word: string, r1: number, caseRemoved: boolean): string {
  if (!caseRemoved) return word

  if (suffixInR1(word, 'j', r1)) {
    const base = word.slice(0, -1)
    if (base.endsWith('o') || base.endsWith('u')) {
      return base
    }
  }

  if (suffixInR1(word, 'o', r1)) {
    const base = word.slice(0, -1)
    if (base.endsWith('j')) {
      return base
    }
  }

  if (suffixInR1(word, 'i', r1)) {
    return word.slice(0, -1)
  }

  return word
}

/**
 * Step 6: When no case ending was removed, try to remove 't' (if preceded by
 * a vowel and in R1), then optionally remove mma/imma suffixes from R2.
 */
function step6(word: string, r1: number, r2: number, caseRemoved: boolean): string {
  if (caseRemoved) return word

  if (suffixInR1(word, 't', r1)) {
    const base = word.slice(0, -1)
    if (base.length > 0 && isVowel(base[base.length - 1])) {
      word = base

      if (suffixInR2(word, 'imma', r2)) {
        return word.slice(0, -4)
      }
      if (suffixInR2(word, 'mma', r2)) {
        const beforeMma = word.slice(0, -3)
        if (!beforeMma.endsWith('po')) {
          return beforeMma
        }
      }
    }
  }

  return word
}

/**
 * Step 7: Final tidying.
 * If the word ends in a long vowel within R1, shorten it.
 * Then walk back to the last vowel and undouble any trailing consonant.
 */
function step7(word: string, r1: number): string {
  if (word.length >= 2 && word.length - 1 >= r1 && endsWithLongVowel(word)) {
    word = word.slice(0, -1)
  }

  let trimmed = word
  while (trimmed.length > r1) {
    const last = trimmed[trimmed.length - 1]
    if (!isConsonant(last)) break
    trimmed = trimmed.slice(0, -1)
  }

  if (trimmed.length > 0 && isVowel(trimmed[trimmed.length - 1])) {
    const afterVowel = word.slice(trimmed.length)
    if (afterVowel.length >= 2) {
      const first = afterVowel[0]
      const second = afterVowel[1]
      if (isConsonant(first) && first === second) {
        word = word.slice(0, trimmed.length) + first + afterVowel.slice(2)
      }
    }
  }

  return word
}

function stem(word: string): string {
  if (word.length < 3) return word

  word = word.toLowerCase()
  const { r1, r2 } = computeRegions(word)

  word = step1(word, r1, r2)
  word = step2(word, r1)

  const result = step3(word, r1)
  word = result.word
  const caseRemoved = result.caseRemoved

  word = step4(word, r2)
  word = step5(word, r1, caseRemoved)
  word = step6(word, r1, r2, caseRemoved)
  word = step7(word, r1)

  return word
}

const stopWords = new Set([
  'olla',
  'olen',
  'olet',
  'on',
  'olemme',
  'olette',
  'ovat',
  'ole',
  'oli',
  'olisi',
  'olisit',
  'olisin',
  'olisimme',
  'olisitte',
  'olisivat',
  'olit',
  'olin',
  'olimme',
  'olitte',
  'olivat',
  'ollut',
  'olleet',
  'en',
  'et',
  'ei',
  'emme',
  'ette',
  'eivät',
  'minä',
  'minun',
  'minut',
  'minua',
  'minussa',
  'minusta',
  'minuun',
  'minulla',
  'minulta',
  'minulle',
  'sinä',
  'sinun',
  'sinut',
  'sinua',
  'sinussa',
  'sinusta',
  'sinuun',
  'sinulla',
  'sinulta',
  'sinulle',
  'hän',
  'hänen',
  'hänet',
  'häntä',
  'hänessä',
  'hänestä',
  'häneen',
  'hänellä',
  'häneltä',
  'hänelle',
  'me',
  'meidän',
  'meidät',
  'meitä',
  'meissä',
  'meistä',
  'meihin',
  'meillä',
  'meiltä',
  'meille',
  'te',
  'teidän',
  'teidät',
  'teitä',
  'teissä',
  'teistä',
  'teihin',
  'teillä',
  'teiltä',
  'teille',
  'he',
  'heidän',
  'heidät',
  'heitä',
  'heissä',
  'heistä',
  'heihin',
  'heillä',
  'heiltä',
  'heille',
  'tämä',
  'tämän',
  'tätä',
  'tässä',
  'tästä',
  'tähän',
  'tällä',
  'tältä',
  'tälle',
  'tänä',
  'täksi',
  'tuo',
  'tuon',
  'tuota',
  'tuossa',
  'tuosta',
  'tuohon',
  'tuolla',
  'tuolta',
  'tuolle',
  'tuona',
  'tuoksi',
  'se',
  'sen',
  'sitä',
  'siinä',
  'siitä',
  'siihen',
  'sillä',
  'siltä',
  'sille',
  'sinä',
  'siksi',
  'nämä',
  'näiden',
  'näitä',
  'näissä',
  'näistä',
  'näihin',
  'näillä',
  'näiltä',
  'näille',
  'näinä',
  'näiksi',
  'nuo',
  'noiden',
  'noita',
  'noissa',
  'noista',
  'noihin',
  'noilla',
  'noilta',
  'noille',
  'noina',
  'noiksi',
  'ne',
  'niiden',
  'niitä',
  'niissä',
  'niistä',
  'niihin',
  'niillä',
  'niiltä',
  'niille',
  'niinä',
  'niiksi',
  'kuka',
  'kenen',
  'kenet',
  'ketä',
  'kenessä',
  'kenestä',
  'keneen',
  'kenellä',
  'keneltä',
  'kenelle',
  'kenenä',
  'keneksi',
  'ketkä',
  'keiden',
  'keitä',
  'keissä',
  'keistä',
  'keihin',
  'keillä',
  'keiltä',
  'keille',
  'keinä',
  'keiksi',
  'mikä',
  'minkä',
  'mitä',
  'missä',
  'mistä',
  'mihin',
  'millä',
  'miltä',
  'mille',
  'minä',
  'miksi',
  'mitkä',
  'joka',
  'jonka',
  'jota',
  'jossa',
  'josta',
  'johon',
  'jolla',
  'jolta',
  'jolle',
  'jona',
  'joksi',
  'jotka',
  'joiden',
  'joita',
  'joissa',
  'joista',
  'joihin',
  'joilla',
  'joilta',
  'joille',
  'joina',
  'joiksi',
  'että',
  'ja',
  'jos',
  'koska',
  'kuin',
  'mutta',
  'niin',
  'sekä',
  'sillä',
  'tai',
  'vaan',
  'vai',
  'vaikka',
  'kanssa',
  'mukaan',
  'noin',
  'poikki',
  'yli',
  'kun',
  'nyt',
  'itse',
])

export const finnish: LanguageModule = {
  name: 'finnish',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9äö]+/gi },
}
