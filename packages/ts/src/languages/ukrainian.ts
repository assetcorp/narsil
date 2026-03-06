import type { LanguageModule } from '../types/language'

const VOWELS = 'аеиоуюяіїє'

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch)
}

function findRegions(word: string): { rv: number; r1: number; r2: number } {
  let rv = word.length
  let r1 = word.length
  let r2 = word.length

  for (let i = 0; i < word.length; i++) {
    if (isVowel(word[i])) {
      rv = i + 1
      break
    }
  }

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

  return { rv, r1, r2 }
}

function removeSuffix(word: string, suffix: string, regionStart: number): string | null {
  if (!word.endsWith(suffix)) return null
  if (word.length - suffix.length < regionStart) return null
  return word.slice(0, word.length - suffix.length)
}

function findAndRemoveSuffix(word: string, suffixes: string[], regionStart: number): string | null {
  for (const suffix of suffixes) {
    const result = removeSuffix(word, suffix, regionStart)
    if (result !== null) return result
  }
  return null
}

const PERFECTIVE_GERUND_GROUP1 = ['вшись', 'вши', 'в']
const PERFECTIVE_GERUND_GROUP2 = ['івшись', 'ивши', 'ів']

function removePerfectiveGerund(word: string, rv: number): string | null {
  for (const suffix of PERFECTIVE_GERUND_GROUP1) {
    if (word.endsWith(suffix) && word.length - suffix.length >= rv) {
      const base = word.slice(0, word.length - suffix.length)
      if (base.endsWith('а') || base.endsWith('я')) {
        return base
      }
    }
  }
  return findAndRemoveSuffix(word, PERFECTIVE_GERUND_GROUP2, rv)
}

const REFLEXIVE_SUFFIXES = ['ся', 'сь']

function removeReflexive(word: string, rv: number): string | null {
  return findAndRemoveSuffix(word, REFLEXIVE_SUFFIXES, rv)
}

const ADJECTIVE_SUFFIXES = [
  'ими',
  'ій',
  'ий',
  'їй',
  'ою',
  'ого',
  'ому',
  'ее',
  'іе',
  'іє',
  'ие',
  'ої',
  'їй',
  'ем',
  'ім',
  'ом',
  'им',
  'их',
  'іх',
  'ую',
  'юю',
  'ая',
  'яя',
  'ое',
  'еє',
]

const PARTICIPLE_GROUP1 = ['ем', 'нн', 'вш', 'ющ', 'щ']
const PARTICIPLE_GROUP2 = ['івш', 'ивш', 'уюч', 'ующ']

function removeAdjectival(word: string, rv: number): string | null {
  const adjResult = findAndRemoveSuffix(word, ADJECTIVE_SUFFIXES, rv)
  if (adjResult === null) return null

  for (const suffix of PARTICIPLE_GROUP1) {
    if (adjResult.endsWith(suffix) && adjResult.length - suffix.length >= rv) {
      const base = adjResult.slice(0, adjResult.length - suffix.length)
      if (base.endsWith('а') || base.endsWith('я')) {
        return base
      }
    }
  }

  const partResult = findAndRemoveSuffix(adjResult, PARTICIPLE_GROUP2, rv)
  if (partResult !== null) return partResult

  return adjResult
}

const VERB_GROUP1 = [
  'ла',
  'на',
  'ете',
  'йте',
  'ли',
  'й',
  'л',
  'ем',
  'н',
  'ло',
  'но',
  'ет',
  'ют',
  'ни',
  'ть',
  'ешь',
  'нно',
]

const VERB_GROUP2 = [
  'ила',
  'ила',
  'ена',
  'ейте',
  'уйте',
  'іте',
  'ите',
  'или',
  'ей',
  'уй',
  'ив',
  'ил',
  'ім',
  'им',
  'ен',
  'ило',
  'ено',
  'ять',
  'ує',
  'ують',
  'ить',
  'іть',
  'ішь',
  'ую',
  'ю',
]

function removeVerb(word: string, rv: number): string | null {
  for (const suffix of VERB_GROUP1) {
    if (word.endsWith(suffix) && word.length - suffix.length >= rv) {
      const base = word.slice(0, word.length - suffix.length)
      if (base.endsWith('а') || base.endsWith('я')) {
        return base
      }
    }
  }
  return findAndRemoveSuffix(word, VERB_GROUP2, rv)
}

const NOUN_SUFFIXES = [
  'іями',
  'ями',
  'іям',
  'ієм',
  'ією',
  'ами',
  'еві',
  'ів',
  'їв',
  'ій',
  'ей',
  'ем',
  'єм',
  'єю',
  'ов',
  'ові',
  'ой',
  'ом',
  'ою',
  'ію',
  'ью',
  'ія',
  'ья',
  'ям',
  'ях',
  'ах',
  'ам',
  'а',
  'е',
  'є',
  'і',
  'ї',
  'и',
  'й',
  'о',
  'у',
  'ь',
  'ю',
  'я',
]

function removeNoun(word: string, rv: number): string | null {
  return findAndRemoveSuffix(word, NOUN_SUFFIXES, rv)
}

const DERIVATIONAL_SUFFIXES = ['ість', 'ость', 'іст', 'ост']

function removeDerivational(word: string, r2: number): string {
  const result = findAndRemoveSuffix(word, DERIVATIONAL_SUFFIXES, r2)
  return result ?? word
}

function step1(word: string, rv: number): string {
  const pgResult = removePerfectiveGerund(word, rv)
  if (pgResult !== null) return pgResult

  const reflexResult = removeReflexive(word, rv)
  const base = reflexResult ?? word

  const adjResult = removeAdjectival(base, rv)
  if (adjResult !== null) return adjResult

  const verbResult = removeVerb(base, rv)
  if (verbResult !== null) return verbResult

  const nounResult = removeNoun(base, rv)
  if (nounResult !== null) return nounResult

  return base
}

function step2(word: string, rv: number): string {
  if (word.endsWith('и') && word.length - 1 >= rv) {
    return word.slice(0, -1)
  }
  return word
}

function step3(word: string, r2: number): string {
  return removeDerivational(word, r2)
}

function step4(word: string, rv: number): string {
  if (word.endsWith('ейше') && word.length - 4 >= rv) {
    return word.slice(0, -4)
  }
  if (word.endsWith('ейш') && word.length - 3 >= rv) {
    return word.slice(0, -3)
  }

  if (word.endsWith('нн') && word.length - 2 >= rv) {
    return word.slice(0, -1)
  }

  if (word.endsWith('ь') && word.length - 1 >= rv) {
    return word.slice(0, -1)
  }

  return word
}

function stem(word: string): string {
  const { rv, r2 } = findRegions(word)

  word = step1(word, rv)
  word = step2(word, rv)
  word = step3(word, r2)
  word = step4(word, rv)

  return word
}

const stopWords = new Set([
  'а',
  'але',
  'б',
  'без',
  'би',
  'біля',
  'більш',
  'бо',
  'був',
  'була',
  'були',
  'було',
  'бути',
  'в',
  'вам',
  'вас',
  'ваш',
  'ваша',
  'ваше',
  'ваші',
  'весь',
  'ви',
  'від',
  'він',
  'вона',
  'воно',
  'вони',
  'все',
  'вся',
  'всі',
  'всю',
  'г',
  'д',
  'да',
  'дали',
  'два',
  'де',
  'дещо',
  'до',
  'добре',
  'другий',
  'е',
  'є',
  'ж',
  'з',
  'за',
  'зараз',
  'зі',
  'і',
  'із',
  'ій',
  'інколи',
  'інший',
  'їй',
  'їм',
  'їх',
  'її',
  'й',
  'його',
  'йому',
  'к',
  'кожен',
  'кожна',
  'коли',
  'котрий',
  'котра',
  'кому',
  'крім',
  'л',
  'м',
  'ми',
  'між',
  'мій',
  'мною',
  'мого',
  'може',
  'можна',
  'моя',
  'моє',
  'моєму',
  'моїй',
  'моїх',
  'мою',
  'н',
  'на',
  'навіть',
  'над',
  'нам',
  'нас',
  'наш',
  'наша',
  'наше',
  'наших',
  'не',
  'ні',
  'ніж',
  'ніколи',
  'нічого',
  'о',
  'обидва',
  'один',
  'однак',
  'одна',
  'одне',
  'одні',
  'він',
  'п',
  'під',
  'після',
  'по',
  'при',
  'про',
  'р',
  'раз',
  'с',
  'сам',
  'сама',
  'саме',
  'самі',
  'свій',
  'свого',
  'свою',
  'свої',
  'себе',
  'серед',
  'ся',
  'т',
  'та',
  'так',
  'також',
  'такий',
  'таких',
  'там',
  'те',
  'тебе',
  'теж',
  'тепер',
  'ти',
  'тим',
  'тих',
  'то',
  'тобі',
  'того',
  'тоді',
  'тому',
  'тут',
  'у',
  'увесь',
  'усе',
  'усі',
  'усю',
  'уся',
  'ф',
  'х',
  'хай',
  'хоч',
  'хоча',
  'хто',
  'ц',
  'це',
  'цей',
  'ця',
  'цього',
  'цей',
  'цим',
  'ці',
  'цій',
  'цю',
  'ч',
  'чи',
  'чий',
  'чого',
  'чому',
  'ш',
  'що',
  'щоб',
  'щось',
  'я',
  'як',
  'яка',
  'яке',
  'які',
  'якщо',
])

export const ukrainian: LanguageModule = {
  name: 'ukrainian',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9а-яіїєґ]+/gi },
}
