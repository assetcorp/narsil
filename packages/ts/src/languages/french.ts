import type { LanguageModule } from '../types/language'

const VOWELS = 'aeiouyâàëéèïîôùûü'

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch)
}

function findRegions(word: string): { rv: number; r1: number; r2: number } {
  let rv = word.length
  let r1 = word.length
  let r2 = word.length

  /**
   * RV for French:
   * If the word begins with two vowels, RV is the region after the third letter.
   * Otherwise, RV is the region after the first vowel not at the beginning of the
   * word, or after the third letter if no vowel is found in that range.
   * Special case: par, col, tap set RV to after the prefix.
   */
  if (word.length >= 2 && isVowel(word[0]) && isVowel(word[1])) {
    rv = 3
  } else if (word.startsWith('par') || word.startsWith('col') || word.startsWith('tap')) {
    rv = 3
  } else {
    for (let i = 1; i < word.length; i++) {
      if (isVowel(word[i])) {
        rv = i + 1
        break
      }
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

function markVowelConsonantForms(word: string): string {
  const chars = word.split('')

  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === 'u' && i > 0 && i < chars.length - 1 && isVowel(chars[i - 1]) && isVowel(chars[i + 1])) {
      chars[i] = 'U'
    }
    if (chars[i] === 'i' && i > 0 && i < chars.length - 1 && isVowel(chars[i - 1]) && isVowel(chars[i + 1])) {
      chars[i] = 'I'
    }
    if (chars[i] === 'y' && i > 0 && isVowel(chars[i - 1])) {
      chars[i] = 'Y'
    }
    if (chars[i] === 'y' && i < chars.length - 1 && isVowel(chars[i + 1])) {
      chars[i] = 'Y'
    }
    if (chars[i] === 'u' && i > 0 && chars[i - 1] === 'q') {
      chars[i] = 'U'
    }
  }

  return chars.join('')
}

function restoreMarkedLetters(word: string): string {
  return word.replace(/I/g, 'i').replace(/U/g, 'u').replace(/Y/g, 'y')
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

function step1StandardSuffix(word: string, rv: number, r1: number, r2: number): { word: string; changed: boolean } {
  const standardSuffixes = [
    'issements',
    'issement',
    'atrices',
    'atrice',
    'ateurs',
    'ateur',
    'ations',
    'ation',
    'usions',
    'ution',
    'usion',
    'utions',
    'logies',
    'logie',
    'ements',
    'ement',
    'ences',
    'ence',
    'ances',
    'ance',
    'ables',
    'able',
    'ismes',
    'isme',
    'istes',
    'iste',
    'euses',
    'euse',
    'ments',
    'ment',
    'iqUes',
    'iqUe',
    'ités',
    'ité',
    'ives',
    'ive',
    'eaux',
    'ifs',
    'if',
    'aux',
    'eux',
  ]

  const suffix = findLongestAmong(word, standardSuffixes, 0)
  if (!suffix) return { word, changed: false }

  if (['ance', 'ances', 'iqUe', 'iqUes', 'isme', 'ismes', 'able', 'ables', 'iste', 'istes'].includes(suffix)) {
    if (suffixInRegion(word, suffix, r2)) {
      return { word: removeSuffix(word, suffix), changed: true }
    }
    return { word, changed: false }
  }

  if (['atrice', 'atrices', 'ateur', 'ateurs', 'ation', 'ations'].includes(suffix)) {
    if (suffixInRegion(word, suffix, r2)) {
      word = removeSuffix(word, suffix)
      if (endsWith(word, 'ic')) {
        if (suffixInRegion(word, 'ic', r2)) {
          word = removeSuffix(word, 'ic')
        } else {
          word = `${removeSuffix(word, 'ic')}iqU`
        }
      }
      return { word, changed: true }
    }
    return { word, changed: false }
  }

  if (['logie', 'logies'].includes(suffix)) {
    if (suffixInRegion(word, suffix, r2)) {
      return { word: `${removeSuffix(word, suffix)}log`, changed: true }
    }
    return { word, changed: false }
  }

  if (['usion', 'usions', 'ution', 'utions'].includes(suffix)) {
    if (suffixInRegion(word, suffix, r2)) {
      return { word: `${removeSuffix(word, suffix)}u`, changed: true }
    }
    return { word, changed: false }
  }

  if (['ence', 'ences'].includes(suffix)) {
    if (suffixInRegion(word, suffix, r2)) {
      return { word: `${removeSuffix(word, suffix)}ent`, changed: true }
    }
    return { word, changed: false }
  }

  if (suffix === 'ement' || suffix === 'ements') {
    if (suffixInRegion(word, suffix, rv)) {
      word = removeSuffix(word, suffix)

      if (endsWith(word, 'iv') && suffixInRegion(word, 'iv', r2)) {
        word = removeSuffix(word, 'iv')
        if (endsWith(word, 'at') && suffixInRegion(word, 'at', r2)) {
          word = removeSuffix(word, 'at')
        }
      } else if (endsWith(word, 'eus')) {
        if (suffixInRegion(word, 'eus', r2)) {
          word = removeSuffix(word, 'eus')
        } else if (suffixInRegion(word, 'eus', r1)) {
          word = `${removeSuffix(word, 'eus')}eux`
        }
      } else if (endsWith(word, 'abl') && suffixInRegion(word, 'abl', r2)) {
        word = removeSuffix(word, 'abl')
      } else if (endsWith(word, 'iqU') && suffixInRegion(word, 'iqU', r2)) {
        word = removeSuffix(word, 'iqU')
      } else if ((endsWith(word, 'ièr') || endsWith(word, 'Ièr')) && suffixInRegion(word, 'ièr', rv)) {
        const sSuffix = endsWith(word, 'Ièr') ? 'Ièr' : 'ièr'
        word = `${removeSuffix(word, sSuffix)}i`
      }

      return { word, changed: true }
    }
    return { word, changed: false }
  }

  if (['ité', 'ités'].includes(suffix)) {
    if (suffixInRegion(word, suffix, r2)) {
      word = removeSuffix(word, suffix)
      if (endsWith(word, 'abil') && suffixInRegion(word, 'abil', r2)) {
        word = removeSuffix(word, 'abil')
      } else if (endsWith(word, 'abil')) {
        word = `${removeSuffix(word, 'abil')}abl`
      } else if (endsWith(word, 'ic')) {
        if (suffixInRegion(word, 'ic', r2)) {
          word = removeSuffix(word, 'ic')
        } else {
          word = `${removeSuffix(word, 'ic')}iqU`
        }
      } else if (endsWith(word, 'iv') && suffixInRegion(word, 'iv', r2)) {
        word = removeSuffix(word, 'iv')
      }
      return { word, changed: true }
    }
    return { word, changed: false }
  }

  if (['if', 'ifs', 'ive', 'ives'].includes(suffix)) {
    if (suffixInRegion(word, suffix, r2)) {
      word = removeSuffix(word, suffix)
      if (endsWith(word, 'at') && suffixInRegion(word, 'at', r2)) {
        word = removeSuffix(word, 'at')
        if (endsWith(word, 'ic')) {
          if (suffixInRegion(word, 'ic', r2)) {
            word = removeSuffix(word, 'ic')
          } else {
            word = `${removeSuffix(word, 'ic')}iqU`
          }
        }
      }
      return { word, changed: true }
    }
    return { word, changed: false }
  }

  if (suffix === 'eaux') {
    return { word: `${removeSuffix(word, 'eaux')}eau`, changed: true }
  }

  if (suffix === 'aux') {
    if (suffixInRegion(word, suffix, r1)) {
      return { word: `${removeSuffix(word, 'aux')}al`, changed: true }
    }
    return { word, changed: false }
  }

  if (['euse', 'euses'].includes(suffix)) {
    if (suffixInRegion(word, suffix, r2)) {
      return { word: removeSuffix(word, suffix), changed: true }
    }
    if (suffixInRegion(word, suffix, r1)) {
      return { word: `${removeSuffix(word, suffix)}eux`, changed: true }
    }
    return { word, changed: false }
  }

  if (suffix === 'issement' || suffix === 'issements') {
    if (suffixInRegion(word, suffix, r1)) {
      const stemmed = removeSuffix(word, suffix)
      if (stemmed.length > 0 && !isVowel(stemmed[stemmed.length - 1])) {
        return { word: stemmed, changed: true }
      }
    }
    return { word, changed: false }
  }

  if (suffix === 'amment') {
    if (suffixInRegion(word, suffix, rv)) {
      return { word: `${removeSuffix(word, 'amment')}ant`, changed: true }
    }
    return { word, changed: false }
  }

  if (suffix === 'emment') {
    if (suffixInRegion(word, suffix, rv)) {
      return { word: `${removeSuffix(word, 'emment')}ent`, changed: true }
    }
    return { word, changed: false }
  }

  if (suffix === 'ment' || suffix === 'ments') {
    if (suffixInRegion(word, suffix, rv)) {
      const stemmed = removeSuffix(word, suffix)
      if (stemmed.length > 0 && isVowel(stemmed[stemmed.length - 1])) {
        return { word: stemmed, changed: true }
      }
    }
    return { word, changed: false }
  }

  if (suffix === 'eux') {
    if (suffixInRegion(word, suffix, r2)) {
      return { word: removeSuffix(word, suffix), changed: true }
    }
    return { word, changed: false }
  }

  return { word, changed: false }
}

function step2aIVerbSuffix(word: string, rv: number): { word: string; changed: boolean } {
  const suffixes = [
    'issantes',
    'issante',
    'issants',
    'issant',
    'issions',
    'issons',
    'issais',
    'issait',
    'issiez',
    'issez',
    'isses',
    'isse',
    'iraIent',
    'issaIent',
    'irions',
    'iront',
    'irais',
    'irait',
    'iriez',
    'irons',
    'irent',
    'irez',
    'irai',
    'iras',
    'îmes',
    'îtes',
    'ies',
    'ira',
    'ir',
    'is',
    'it',
    'ie',
    'i',
    'ît',
  ]

  const suffix = findLongestAmong(word, suffixes, rv)
  if (!suffix) return { word, changed: false }

  const stemmed = removeSuffix(word, suffix)
  if (stemmed.length > 0 && !isVowel(stemmed[stemmed.length - 1]) && stemmed[stemmed.length - 1] !== 'H') {
    return { word: stemmed, changed: true }
  }
  return { word, changed: false }
}

function step2bOtherVerbSuffix(word: string, rv: number, r2: number): { word: string; changed: boolean } {
  const group1Suffixes = [
    'eraIent',
    'erions',
    'assions',
    'assent',
    'assiez',
    'erais',
    'erait',
    'eriez',
    'erons',
    'eront',
    'erez',
    'antes',
    'asses',
    'eras',
    'ante',
    'asse',
    'âmes',
    'âtes',
    'ées',
    'era',
    'erai',
    'ais',
    'ait',
    'ant',
    'ée',
    'és',
    'er',
    'ez',
    'ai',
    'as',
    'a',
    'é',
    'ât',
    'èrent',
  ]

  const ionsSuffix = 'ions'
  if (endsWith(word, ionsSuffix) && suffixInRegion(word, ionsSuffix, r2)) {
    return { word: removeSuffix(word, ionsSuffix), changed: true }
  }

  const suffix = findLongestAmong(word, group1Suffixes, rv)
  if (suffix) {
    return { word: removeSuffix(word, suffix), changed: true }
  }

  return { word, changed: false }
}

function step3ResidualSuffix(word: string, rv: number, r2: number): string {
  if (endsWith(word, 's')) {
    const beforeS = word.slice(0, -1)
    if (beforeS.length > 0) {
      const lastChar = beforeS[beforeS.length - 1]
      if (
        lastChar !== 'a' &&
        lastChar !== 'i' &&
        lastChar !== 'o' &&
        lastChar !== 'u' &&
        lastChar !== 'è' &&
        lastChar !== 's'
      ) {
        word = beforeS
      }
    }
  }

  const ionSuffix = 'ion'
  if (endsWith(word, ionSuffix) && suffixInRegion(word, ionSuffix, r2)) {
    const stemmed = removeSuffix(word, ionSuffix)
    if (
      stemmed.length > 0 &&
      (stemmed[stemmed.length - 1] === 's' || stemmed[stemmed.length - 1] === 't') &&
      suffixInRegion(word, ionSuffix, rv)
    ) {
      return stemmed
    }
  }

  const residualSuffixes = ['Ière', 'ière', 'Ier', 'ier']
  for (const suffix of residualSuffixes) {
    if (endsWith(word, suffix) && suffixInRegion(word, suffix, rv)) {
      return `${removeSuffix(word, suffix)}i`
    }
  }

  if (endsWith(word, 'e') && suffixInRegion(word, 'e', rv)) {
    return removeSuffix(word, 'e')
  }

  return word
}

function step4Undouble(word: string): string {
  const doublePatterns = ['enn', 'onn', 'ett', 'ell', 'eill']
  for (const pattern of doublePatterns) {
    if (endsWith(word, pattern)) {
      return word.slice(0, -1)
    }
  }
  return word
}

function step5UnAccent(word: string): string {
  if (word.length < 2) return word

  const lastChar = word[word.length - 1]
  const secondLastChar = word[word.length - 2]

  if ((lastChar === 'é' || lastChar === 'è') && !isVowel(secondLastChar)) {
    return `${word.slice(0, -1)}e`
  }

  if (!isVowel(lastChar) && (secondLastChar === 'é' || secondLastChar === 'è')) {
    return `${word.slice(0, -2)}e${lastChar}`
  }

  return word
}

function stem(word: string): string {
  if (word.length < 3) return word

  if (word[0] === 'y') {
    word = `Y${word.slice(1)}`
  }

  word = markVowelConsonantForms(word)

  const { rv, r1, r2 } = findRegions(word)

  const step1Result = step1StandardSuffix(word, rv, r1, r2)
  let stemChanged = step1Result.changed
  word = step1Result.word

  if (!stemChanged) {
    const step2aResult = step2aIVerbSuffix(word, rv)
    if (step2aResult.changed) {
      word = step2aResult.word
      stemChanged = true
    } else {
      const step2bResult = step2bOtherVerbSuffix(word, rv, r2)
      word = step2bResult.word
      stemChanged = step2bResult.changed
    }
  }

  if (stemChanged) {
    if (endsWith(word, 'Y')) {
      word = `${word.slice(0, -1)}i`
    }
    if (endsWith(word, 'ç')) {
      word = `${word.slice(0, -1)}c`
    }
  } else {
    word = step3ResidualSuffix(word, rv, r2)
  }

  word = step4Undouble(word)
  word = step5UnAccent(word)
  word = restoreMarkedLetters(word)

  return word.toLowerCase()
}

const stopWords = new Set([
  'au',
  'aux',
  'avec',
  'ce',
  'ces',
  'dans',
  'de',
  'des',
  'du',
  'elle',
  'en',
  'et',
  'eux',
  'il',
  'je',
  'la',
  'le',
  'leur',
  'lui',
  'ma',
  'mais',
  'me',
  'même',
  'mes',
  'moi',
  'mon',
  'ne',
  'nos',
  'notre',
  'nous',
  'on',
  'ou',
  'par',
  'pas',
  'pour',
  'qu',
  'que',
  'qui',
  'sa',
  'se',
  'ses',
  'son',
  'sur',
  'ta',
  'te',
  'tes',
  'toi',
  'ton',
  'tu',
  'un',
  'une',
  'vos',
  'votre',
  'vous',
  'c',
  'd',
  'j',
  'l',
  'à',
  'm',
  'n',
  's',
  't',
  'y',
  'été',
  'étée',
  'étées',
  'étés',
  'étant',
  'suis',
  'es',
  'est',
  'sommes',
  'êtes',
  'sont',
  'serai',
  'seras',
  'sera',
  'serons',
  'serez',
  'seront',
  'serais',
  'serait',
  'serions',
  'seriez',
  'seraient',
  'étais',
  'était',
  'étions',
  'étiez',
  'étaient',
  'fus',
  'fut',
  'fûmes',
  'fûtes',
  'furent',
  'sois',
  'soit',
  'soyons',
  'soyez',
  'soient',
  'fusse',
  'fusses',
  'fût',
  'fussions',
  'fussiez',
  'fussent',
  'ayant',
  'eu',
  'eue',
  'eues',
  'eus',
  'ai',
  'as',
  'avons',
  'avez',
  'ont',
  'aurai',
  'auras',
  'aura',
  'aurons',
  'aurez',
  'auront',
  'aurais',
  'aurait',
  'aurions',
  'auriez',
  'auraient',
  'avais',
  'avait',
  'avions',
  'aviez',
  'avaient',
  'eut',
  'eûmes',
  'eûtes',
  'eurent',
  'aie',
  'aies',
  'ait',
  'ayons',
  'ayez',
  'aient',
  'eusse',
  'eusses',
  'eût',
  'eussions',
  'eussiez',
  'eussent',
  'ceci',
  'cela',
  'celà',
  'cet',
  'cette',
  'ici',
  'ils',
  'les',
  'leurs',
  'quel',
  'quels',
  'quelle',
  'quelles',
  'sans',
  'soi',
])

export const french: LanguageModule = {
  name: 'french',
  stemmer: stem,
  stopWords,
  tokenizer: {
    splitPattern: /[^a-z0-9äâàéèëêïîöôùüûœç-]+/gi,
  },
}
