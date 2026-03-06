import type { LanguageModule } from '../types/language'

const VOWELS = 'аеиоуыэюя'

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

const PERFECTIVE_GERUND_GROUP1 = ['в', 'вши', 'вшись']
const PERFECTIVE_GERUND_GROUP2 = ['ив', 'ивши', 'ившись', 'ыв', 'ывши', 'ывшись']

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
  'ыми',
  'его',
  'ого',
  'ему',
  'ому',
  'ее',
  'ие',
  'ое',
  'ые',
  'ей',
  'ий',
  'ой',
  'ый',
  'ем',
  'им',
  'ом',
  'ым',
  'их',
  'ых',
  'ею',
  'ою',
  'ую',
  'юю',
  'ая',
  'яя',
]

const PARTICIPLE_GROUP1 = ['ем', 'нн', 'вш', 'ющ', 'щ']
const PARTICIPLE_GROUP2 = ['ивш', 'ывш', 'ующ']

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
  'ны',
  'ть',
  'ешь',
  'нно',
]

const VERB_GROUP2 = [
  'ила',
  'ыла',
  'ена',
  'ейте',
  'уйте',
  'ите',
  'или',
  'ыли',
  'ей',
  'уй',
  'ил',
  'ыл',
  'им',
  'ым',
  'ен',
  'ило',
  'ыло',
  'ено',
  'ят',
  'ует',
  'уют',
  'ит',
  'ыт',
  'ены',
  'ить',
  'ыть',
  'ишь',
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
  'иями',
  'ями',
  'иям',
  'ией',
  'ием',
  'ами',
  'ии',
  'ев',
  'ов',
  'ие',
  'ье',
  'еи',
  'ей',
  'ий',
  'ой',
  'ам',
  'ям',
  'ем',
  'ом',
  'ях',
  'ах',
  'ию',
  'ью',
  'ия',
  'ья',
  'а',
  'е',
  'и',
  'о',
  'у',
  'ы',
  'ь',
  'ю',
  'я',
]

function removeNoun(word: string, rv: number): string | null {
  return findAndRemoveSuffix(word, NOUN_SUFFIXES, rv)
}

const DERIVATIONAL_SUFFIXES = ['ость', 'ост']

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

const RE_YO = /ё/g

function stem(word: string): string {
  word = word.replace(RE_YO, 'е')

  const { rv, r2 } = findRegions(word)

  word = step1(word, rv)
  word = step2(word, rv)
  word = step3(word, r2)
  word = step4(word, rv)

  return word
}

const stopWords = new Set([
  'и',
  'в',
  'во',
  'не',
  'что',
  'он',
  'на',
  'я',
  'с',
  'со',
  'как',
  'а',
  'то',
  'все',
  'она',
  'так',
  'его',
  'но',
  'да',
  'ты',
  'к',
  'у',
  'же',
  'вы',
  'за',
  'бы',
  'по',
  'только',
  'ее',
  'мне',
  'было',
  'вот',
  'от',
  'меня',
  'еще',
  'нет',
  'о',
  'из',
  'ему',
  'теперь',
  'когда',
  'даже',
  'ну',
  'вдруг',
  'ли',
  'если',
  'уже',
  'или',
  'ни',
  'быть',
  'был',
  'него',
  'до',
  'вас',
  'нибудь',
  'опять',
  'уж',
  'вам',
  'сказал',
  'ведь',
  'там',
  'потом',
  'себя',
  'ничего',
  'ей',
  'может',
  'они',
  'тут',
  'где',
  'есть',
  'надо',
  'ней',
  'для',
  'мы',
  'тебя',
  'их',
  'чем',
  'была',
  'сам',
  'чтоб',
  'без',
  'будто',
  'человек',
  'чего',
  'раз',
  'тоже',
  'себе',
  'под',
  'жизнь',
  'будет',
  'ж',
  'тогда',
  'кто',
  'этот',
  'говорил',
  'того',
  'потому',
  'этого',
  'какой',
  'совсем',
  'ним',
  'здесь',
  'этом',
  'один',
  'почти',
  'мой',
  'тем',
  'чтобы',
  'нее',
  'кажется',
  'сейчас',
  'были',
  'куда',
  'зачем',
  'сказать',
  'всех',
  'никогда',
  'сегодня',
  'можно',
  'при',
  'наконец',
  'два',
  'об',
  'другой',
  'хоть',
  'после',
  'над',
  'больше',
  'тот',
  'через',
  'эти',
  'нас',
  'про',
  'всего',
  'них',
  'какая',
  'много',
  'разве',
  'сказала',
  'три',
  'эту',
  'моя',
  'впрочем',
  'хорошо',
  'свою',
  'этой',
  'перед',
  'иногда',
  'лучше',
  'чуть',
  'том',
  'нельзя',
  'такой',
  'им',
  'более',
  'всегда',
  'конечно',
  'всю',
  'между',
])

export const russian: LanguageModule = {
  name: 'russian',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9а-яё]+/gi },
}
