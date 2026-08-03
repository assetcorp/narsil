/*
 * Stop words sourced from:
 *   - stopwords-iso/stopwords-uk (https://github.com/stopwords-iso), MIT
 *   - Pronouns, prepositions, conjunctions, and particles curated for Narsil
 */

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
  'ого',
  'ому',
  'ій',
  'ий',
  'їй',
  'ою',
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
  'ете',
  'йте',
  'ешь',
  'нно',
  'ла',
  'на',
  'ли',
  'ем',
  'ло',
  'но',
  'ет',
  'ют',
  'ни',
  'ть',
  'й',
  'л',
  'н',
]

const VERB_GROUP2 = [
  'ейте',
  'уйте',
  'ують',
  'ила',
  'ила',
  'ена',
  'іте',
  'ите',
  'или',
  'ило',
  'ено',
  'ять',
  'ить',
  'іть',
  'ішь',
  'ей',
  'уй',
  'ив',
  'ил',
  'ім',
  'им',
  'ен',
  'ує',
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
  'ові',
  'ів',
  'їв',
  'ій',
  'ей',
  'ем',
  'єм',
  'єю',
  'ов',
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
  'аби',
  'або',
  'авжеж',
  'адже',
  'але',
  'ані',
  'б',
  'багато',
  'без',
  'би',
  'біля',
  'більш',
  'бо',
  'буде',
  'будуть',
  'був',
  'була',
  'були',
  'було',
  'бути',
  'в',
  'вам',
  'вами',
  'вас',
  'ваш',
  'ваша',
  'ваше',
  'ваші',
  'вже',
  'весь',
  'ви',
  'вздовж',
  'вниз',
  'внизу',
  'від',
  'він',
  'вона',
  'вони',
  'воно',
  'все',
  'всередині',
  'всю',
  'вся',
  'всі',
  'всіх',
  'да',
  'давай',
  'давати',
  'де',
  'декілька',
  'дещо',
  'деякі',
  'для',
  'до',
  'є',
  'ж',
  'же',
  'з',
  'за',
  'завжди',
  'замість',
  'зараз',
  'зате',
  'звідки',
  'звідси',
  'звідти',
  'зі',
  'і',
  'із',
  'іноді',
  'інколи',
  'інша',
  'інше',
  'інший',
  'інші',
  'інших',
  'їй',
  'їм',
  'їх',
  'їхнє',
  'їхні',
  'їхній',
  'їхня',
  'її',
  'й',
  'його',
  'йому',
  'кого',
  'кожен',
  'кожна',
  'кожне',
  'коли',
  'коло',
  'кому',
  'котра',
  'котре',
  'котрий',
  'котрі',
  'крім',
  'куди',
  'кілька',
  'ледве',
  'лише',
  'майже',
  'мало',
  'мене',
  'мені',
  'ми',
  'мною',
  'мов',
  'мого',
  'моєму',
  'моїй',
  'моїх',
  'мою',
  'може',
  'можна',
  'моя',
  'моє',
  'мої',
  'мій',
  'між',
  'на',
  'навколо',
  'навіть',
  'над',
  'нам',
  'нами',
  'нас',
  'наче',
  'наш',
  'наша',
  'наше',
  'наших',
  'наші',
  'не',
  'немов',
  'нею',
  'неї',
  'ним',
  'ними',
  'них',
  'нього',
  'ньому',
  'ні',
  'ніби',
  'ніж',
  'нікого',
  'ніколи',
  'ніхто',
  'ніщо',
  'нічого',
  'однак',
  'окрім',
  'от',
  'отже',
  'отож',
  'перед',
  'по',
  'поза',
  'при',
  'про',
  'проте',
  'проти',
  'під',
  'після',
  'сам',
  'сама',
  'саме',
  'самі',
  'свого',
  'свою',
  'своя',
  'своє',
  'свої',
  'свій',
  'себе',
  'серед',
  'скільки',
  'собі',
  'собою',
  'сюди',
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
  'тобто',
  'тобі',
  'тобою',
  'того',
  'тоді',
  'той',
  'тому',
  'тож',
  'тощо',
  'ту',
  'туди',
  'тут',
  'ті',
  'тій',
  'тільки',
  'у',
  'увесь',
  'уже',
  'усе',
  'усі',
  'усю',
  'уся',
  'хай',
  'хоч',
  'хоча',
  'хто',
  'хтось',
  'це',
  'цей',
  'цим',
  'цих',
  'цього',
  'цьому',
  'цю',
  'ця',
  'ці',
  'цій',
  'часто',
  'через',
  'чи',
  'чий',
  'чия',
  'чиє',
  'чиї',
  'чого',
  'чому',
  'ще',
  'що',
  'щоб',
  'щоби',
  'щодо',
  'щось',
  'я',
  'як',
  'яка',
  'якби',
  'яке',
  'який',
  'якщо',
  'які',
  'якої',
])

/**
 * Ukrainian analysis: the Snowball stemmer, the stop word list, and the rules
 * that split Ukrainian text into tokens.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `ukrainian`.
 *
 * @public
 */
export const ukrainian: LanguageModule = {
  name: 'ukrainian',
  revision: '1',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9а-яіїєґ']+/gi },
}
