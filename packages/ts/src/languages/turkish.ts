import type { LanguageModule } from '../types/language'

const VOWELS = 'aeıioöuü'
const BACK_UNROUNDED_VOWELS = 'aı'
const FRONT_UNROUNDED_VOWELS = 'ei'
const BACK_ROUNDED_VOWELS = 'ou'
const FRONT_ROUNDED_VOWELS = 'öü'

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch)
}

function vowelCount(word: string): number {
  let count = 0
  for (const ch of word) {
    if (isVowel(ch)) count++
  }
  return count
}

function lastVowel(word: string): string | null {
  for (let i = word.length - 1; i >= 0; i--) {
    if (isVowel(word[i])) return word[i]
  }
  return null
}

function checkVowelHarmony(stem: string, suffix: string): boolean {
  const lv = lastVowel(stem)
  if (lv === null) return false

  const firstSuffixVowel = suffix.split('').find(isVowel)
  if (!firstSuffixVowel) return true

  if (BACK_UNROUNDED_VOWELS.includes(lv)) {
    return BACK_UNROUNDED_VOWELS.includes(firstSuffixVowel)
  }
  if (FRONT_UNROUNDED_VOWELS.includes(lv)) {
    return FRONT_UNROUNDED_VOWELS.includes(firstSuffixVowel)
  }
  if (BACK_ROUNDED_VOWELS.includes(lv)) {
    return BACK_ROUNDED_VOWELS.includes(firstSuffixVowel) || firstSuffixVowel === 'u'
  }
  if (FRONT_ROUNDED_VOWELS.includes(lv)) {
    return FRONT_ROUNDED_VOWELS.includes(firstSuffixVowel) || firstSuffixVowel === 'ü'
  }

  return false
}

function stripSuffix(word: string, suffix: string): string {
  return word.slice(0, word.length - suffix.length)
}

function checkPreconditionN(word: string): boolean {
  if (word.endsWith('n') && word.length > 1) {
    return isVowel(word[word.length - 2])
  }
  return word.length > 0 && !word.endsWith('n') && isVowel(word[word.length - 1])
}

function checkPreconditionY(word: string): boolean {
  if (word.endsWith('y') && word.length > 1) {
    return isVowel(word[word.length - 2])
  }
  return word.length > 0 && !word.endsWith('y') && isVowel(word[word.length - 1])
}

function tryStripWithHarmony(word: string, suffixes: string[], minVowels: number): string {
  for (const suffix of suffixes) {
    if (word.endsWith(suffix)) {
      const candidate = stripSuffix(word, suffix)
      if (vowelCount(candidate) >= minVowels && checkVowelHarmony(candidate, suffix)) {
        return candidate
      }
    }
  }
  return word
}

function tryStripWithHarmonyAndPrecondN(word: string, suffixes: string[], minVowels: number): string {
  for (const suffix of suffixes) {
    if (word.endsWith(suffix)) {
      const candidate = stripSuffix(word, suffix)
      if (vowelCount(candidate) >= minVowels && checkVowelHarmony(candidate, suffix) && checkPreconditionN(candidate)) {
        return candidate
      }
    }
  }
  return word
}

function tryStripWithHarmonyAndPrecondY(word: string, suffixes: string[], minVowels: number): string {
  for (const suffix of suffixes) {
    if (word.endsWith(suffix)) {
      const candidate = stripSuffix(word, suffix)
      if (vowelCount(candidate) >= minVowels && checkVowelHarmony(candidate, suffix) && checkPreconditionY(candidate)) {
        return candidate
      }
    }
  }
  return word
}

function tryStripMinVowels(word: string, suffixes: string[], minVowels: number): string {
  for (const suffix of suffixes) {
    if (word.endsWith(suffix)) {
      const candidate = stripSuffix(word, suffix)
      if (vowelCount(candidate) >= minVowels) return candidate
    }
  }
  return word
}

function tryRemovePossessiveLari(word: string): string {
  return tryStripMinVowels(word, ['ları', 'leri'], 2)
}

function tryRemovePlural(word: string): string {
  return tryStripWithHarmony(word, ['lar', 'ler'], 2)
}

function tryRemovePossessiveM(word: string): string {
  return tryStripWithHarmony(word, ['ım', 'im', 'um', 'üm', 'm'], 2)
}

function tryRemovePossessiveN(word: string): string {
  return tryStripWithHarmony(word, ['ın', 'in', 'un', 'ün', 'n'], 2)
}

function tryRemovePossessiveMiz(word: string): string {
  return tryStripWithHarmony(word, ['mız', 'miz', 'muz', 'müz'], 2)
}

function tryRemovePossessiveNiz(word: string): string {
  return tryStripWithHarmony(word, ['nız', 'niz', 'nuz', 'nüz'], 2)
}

function tryRemoveCaseDa(word: string): string {
  return tryStripWithHarmony(word, ['da', 'de', 'ta', 'te'], 2)
}

function tryRemoveCaseDan(word: string): string {
  return tryStripWithHarmony(word, ['dan', 'den', 'tan', 'ten'], 2)
}

function tryRemoveCaseNa(word: string): string {
  return tryStripWithHarmony(word, ['na', 'ne'], 2)
}

function tryRemoveCaseA(word: string): string {
  return tryStripWithHarmony(word, ['a', 'e'], 2)
}

function tryRemoveGenitive(word: string): string {
  return tryStripWithHarmonyAndPrecondN(word, ['ın', 'in', 'un', 'ün'], 2)
}

function tryRemoveAccusative(word: string): string {
  const long = tryStripWithHarmony(word, ['nı', 'ni', 'nu', 'nü'], 2)
  if (long !== word) return long
  return tryStripWithHarmonyAndPrecondY(word, ['ı', 'i', 'u', 'ü'], 2)
}

function tryRemoveCopulaDi(word: string): string {
  return tryStripWithHarmonyAndPrecondY(
    word,
    [
      'dik',
      'tik',
      'duk',
      'tuk',
      'dük',
      'tük',
      'dık',
      'tık',
      'dim',
      'tim',
      'dum',
      'tum',
      'düm',
      'tüm',
      'dım',
      'tım',
      'din',
      'tin',
      'dun',
      'tun',
      'dün',
      'tün',
      'dın',
      'tın',
      'di',
      'ti',
      'du',
      'tu',
      'dü',
      'tü',
      'dı',
      'tı',
    ],
    2,
  )
}

function tryRemoveCopulaSa(word: string): string {
  return tryStripWithHarmonyAndPrecondY(word, ['sak', 'sek', 'sam', 'sem', 'san', 'sen', 'sa', 'se'], 2)
}

function tryRemoveCopulaMis(word: string): string {
  return tryStripWithHarmonyAndPrecondY(word, ['miş', 'muş', 'müş', 'mış'], 2)
}

function tryRemoveCopulaSiniz(word: string): string {
  return tryStripWithHarmony(word, ['siniz', 'sunuz', 'sünüz', 'sınız'], 2)
}

function tryRemoveCopulaLar(word: string): string {
  return tryStripWithHarmony(word, ['lar', 'ler'], 2)
}

function tryRemoveCopulaCasina(word: string): string {
  return tryStripMinVowels(word, ['casına', 'cesine'], 2)
}

function tryRemoveCopulaDir(word: string): string {
  return tryStripWithHarmony(word, ['dir', 'tir', 'dur', 'tur', 'dür', 'tür', 'dır', 'tır'], 2)
}

function tryRemoveWithLa(word: string): string {
  return tryStripWithHarmonyAndPrecondY(word, ['la', 'le'], 2)
}

function tryRemoveWithCa(word: string): string {
  return tryStripWithHarmonyAndPrecondN(word, ['ca', 'ce'], 2)
}

function tryRemoveKen(word: string): string {
  if (word.endsWith('ken')) {
    const candidate = stripSuffix(word, 'ken')
    if (vowelCount(candidate) >= 2 && checkPreconditionY(candidate)) {
      return candidate
    }
  }
  return word
}

function changed(original: string, current: string): boolean {
  return original !== current
}

const CONSONANT_SOFTENING: Record<string, string> = {
  b: 'p',
  c: 'ç',
  d: 't',
  ğ: 'k',
}

function handleConsonantSoftening(word: string): string {
  if (word.length > 0) {
    const last = word[word.length - 1]
    if (last in CONSONANT_SOFTENING) {
      return word.slice(0, -1) + CONSONANT_SOFTENING[last]
    }
  }

  return word
}

function handleVowelInsertion(word: string): string {
  if (word.length < 2) return word

  const last = word[word.length - 1]
  if (last !== 'd' && last !== 'g') return word

  const beforeLast = word.slice(0, -1)
  const lv = lastVowel(beforeLast)
  if (lv === null) return word

  let insertedVowel: string

  if (BACK_UNROUNDED_VOWELS.includes(lv)) insertedVowel = 'ı'
  else if (FRONT_UNROUNDED_VOWELS.includes(lv)) insertedVowel = 'i'
  else if (BACK_ROUNDED_VOWELS.includes(lv)) insertedVowel = 'u'
  else if (FRONT_ROUNDED_VOWELS.includes(lv)) insertedVowel = 'ü'
  else insertedVowel = 'ı'

  return beforeLast + insertedVowel + last
}

function nominalVerbSuffixes(word: string): { word: string; removed: boolean } {
  const original = word
  let removed = false
  let result: string

  result = tryRemoveCopulaMis(word)
  if (changed(word, result)) {
    word = result
    removed = true
  }

  if (!removed) {
    result = tryRemoveCopulaDi(word)
    if (changed(word, result)) {
      word = result
      removed = true
    }
  }

  if (!removed) {
    result = tryRemoveCopulaSa(word)
    if (changed(word, result)) {
      word = result
      removed = true
    }
  }

  if (!removed) {
    result = tryRemoveKen(word)
    if (changed(word, result)) {
      word = result
      removed = true
    }
  }

  if (!removed) {
    result = tryRemoveCopulaCasina(word)
    if (changed(word, result)) {
      word = result

      result = tryRemoveCopulaSiniz(word)
      if (changed(word, result)) {
        word = result
      } else {
        result = tryRemoveCopulaLar(word)
        if (changed(word, result)) {
          word = result
        } else {
          result = tryRemoveCopulaDir(word)
          if (changed(word, result)) {
            word = result
          } else {
            result = tryRemoveCopulaMis(word)
            if (changed(word, result)) word = result
          }
        }
      }

      return { word, removed: true }
    }
  }

  if (removed) {
    result = tryRemovePossessiveM(word)
    if (changed(word, result)) {
      word = result
    } else {
      result = tryRemovePossessiveN(word)
      if (changed(word, result)) {
        word = result
      } else {
        result = tryRemovePossessiveMiz(word)
        if (changed(word, result)) {
          word = result
        } else {
          result = tryRemovePossessiveNiz(word)
          if (changed(word, result)) {
            word = result
          } else {
            result = tryRemoveCopulaSiniz(word)
            if (changed(word, result)) {
              word = result
            } else {
              result = tryRemoveCopulaLar(word)
              if (changed(word, result)) word = result
            }
          }
        }
      }
    }

    result = tryRemoveCopulaMis(word)
    if (changed(word, result)) word = result
  }

  return { word, removed: changed(original, word) }
}

function nounSuffixes(word: string): string {
  let result: string

  result = tryRemovePossessiveLari(word)
  if (changed(word, result)) return result

  result = tryRemovePlural(word)
  if (changed(word, result)) {
    word = result
    result = tryRemoveAccusative(word)
    if (changed(word, result)) return result
    result = tryRemovePossessiveLari(word)
    if (changed(word, result)) return result
    return word
  }

  result = tryRemoveCaseDa(word)
  if (changed(word, result)) {
    word = result
    result = tryRemovePossessiveLari(word)
    if (changed(word, result)) return result
    result = tryRemovePossessiveM(word)
    if (changed(word, result)) return result
    result = tryRemovePossessiveN(word)
    if (changed(word, result)) return result
    result = tryRemovePossessiveMiz(word)
    if (changed(word, result)) return result
    result = tryRemovePossessiveNiz(word)
    if (changed(word, result)) return result
    return word
  }

  result = tryRemoveCaseDan(word)
  if (changed(word, result)) {
    word = result
    result = tryRemovePossessiveLari(word)
    if (changed(word, result)) return result
    result = tryRemovePossessiveM(word)
    if (changed(word, result)) return result
    result = tryRemovePossessiveN(word)
    if (changed(word, result)) return result
    result = tryRemovePossessiveMiz(word)
    if (changed(word, result)) return result
    result = tryRemovePossessiveNiz(word)
    if (changed(word, result)) return result
    return word
  }

  result = tryRemoveCaseNa(word)
  if (changed(word, result)) {
    word = result
    result = tryRemoveGenitive(word)
    if (changed(word, result)) return result
    result = tryRemoveAccusative(word)
    if (changed(word, result)) return result
    return word
  }

  result = tryRemoveGenitive(word)
  if (changed(word, result)) {
    word = result
    result = tryRemovePossessiveLari(word)
    if (changed(word, result)) return result
    result = tryRemoveCopulaMis(word)
    if (changed(word, result)) return result
    return word
  }

  result = tryRemoveAccusative(word)
  if (changed(word, result)) {
    word = result
    result = tryRemoveCopulaMis(word)
    if (changed(word, result)) return result
    return word
  }

  result = tryRemoveCaseA(word)
  if (changed(word, result)) return result

  result = tryRemoveWithCa(word)
  if (changed(word, result)) {
    word = result
    result = tryRemoveGenitive(word)
    if (changed(word, result)) return result
    result = tryRemoveAccusative(word)
    if (changed(word, result)) return result
    return word
  }

  result = tryRemoveWithLa(word)
  if (changed(word, result)) return result

  return word
}

function stem(word: string): string {
  if (vowelCount(word) < 2) return word

  const { word: afterNominal, removed: nominalRemoved } = nominalVerbSuffixes(word)
  word = afterNominal

  if (!nominalRemoved) return word

  word = nounSuffixes(word)

  if (word.endsWith('soyad') || word === 'ad') return word

  word = handleVowelInsertion(word)
  word = handleConsonantSoftening(word)

  return word
}

const stopWords = new Set([
  'acaba',
  'acep',
  'adeta',
  'altmış',
  'altı',
  'ama',
  'ancak',
  'arada',
  'aslında',
  'aynen',
  'ayrıca',
  'az',
  'bana',
  'bari',
  'bazen',
  'bazı',
  'belki',
  'ben',
  'benden',
  'beni',
  'benim',
  'beri',
  'beş',
  'bile',
  'bin',
  'bir',
  'biraz',
  'biri',
  'birkaç',
  'birkez',
  'birçok',
  'birşey',
  'birşeyi',
  'biz',
  'bizden',
  'bize',
  'bizi',
  'bizim',
  'bu',
  'buna',
  'bunda',
  'bundan',
  'bunlar',
  'bunları',
  'bunların',
  'bunu',
  'bunun',
  'burada',
  'böyle',
  'böylece',
  'bütün',
  'da',
  'daha',
  'dahi',
  'dahil',
  'daima',
  'dair',
  'dayanarak',
  'de',
  'defa',
  'değil',
  'diye',
  'diğer',
  'doksan',
  'dokuz',
  'dolayı',
  'dolayısıyla',
  'dört',
  'edecek',
  'eden',
  'ederek',
  'edilecek',
  'ediliyor',
  'edilmesi',
  'ediyor',
  'elli',
  'en',
  'etmesi',
  'etti',
  'ettiği',
  'ettiğini',
  'eğer',
  'fakat',
  'gibi',
  'göre',
  'halbuki',
  'halen',
  'hangi',
  'hani',
  'hariç',
  'hatta',
  'hele',
  'hem',
  'henüz',
  'hep',
  'hepsi',
  'her',
  'herhangi',
  'herkes',
  'herkesin',
  'hiç',
  'hiçbir',
  'iken',
  'iki',
  'ila',
  'ile',
  'ilgili',
  'ilk',
  'illa',
  'ise',
  'itibaren',
  'itibariyle',
  'iyi',
  'iyice',
  'için',
  'işte',
  'kadar',
  'karşın',
  'katrilyon',
  'kendi',
  'kendilerine',
  'kendini',
  'kendisi',
  'kendisine',
  'kendisini',
  'kere',
  'kez',
  'ki',
  'kim',
  'kimden',
  'kime',
  'kimi',
  'kimse',
  'kırk',
  'lakin',
  'madem',
  'milyar',
  'milyon',
  'mu',
  'mü',
  'mı',
  'nasıl',
  'ne',
  'neden',
  'nedenle',
  'nerde',
  'nere',
  'nerede',
  'nereye',
  'nitekim',
  'niye',
  'niçin',
  'o',
  'olan',
  'olarak',
  'oldu',
  'olduklarını',
  'olduğu',
  'olduğunu',
  'olmadı',
  'olmadığı',
  'olmak',
  'olması',
  'olmayan',
  'olmaz',
  'olsa',
  'olsun',
  'olup',
  'olur',
  'olursa',
  'oluyor',
  'on',
  'ona',
  'ondan',
  'onlar',
  'onlardan',
  'onlari',
  'onları',
  'onların',
  'onu',
  'onun',
  'otuz',
  'oysa',
  'pek',
  'rağmen',
  'sadece',
  'sanki',
  'sekiz',
  'seksen',
  'sen',
  'senden',
  'seni',
  'senin',
  'siz',
  'sizden',
  'sizi',
  'sizin',
  'sonra',
  'tarafından',
  'trilyon',
  'tüm',
  'var',
  'vardı',
  've',
  'veya',
  'veyahut',
  'ya',
  'yahut',
  'yani',
  'yapacak',
  'yapmak',
  'yaptı',
  'yaptıkları',
  'yaptığı',
  'yaptığını',
  'yapılan',
  'yapılması',
  'yapıyor',
  'yedi',
  'yerine',
  'yetmiş',
  'yine',
  'yirmi',
  'yoksa',
  'yüz',
  'zaten',
  'çok',
  'çünkü',
  'öyle',
  'üzere',
  'üç',
  'şey',
  'şeyden',
  'şeyi',
  'şeyler',
  'şu',
  'şuna',
  'şunda',
  'şundan',
  'şunları',
  'şunu',
  'şöyle',
])

export const turkish: LanguageModule = {
  name: 'turkish',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9çğıöşü]+/gi },
}
