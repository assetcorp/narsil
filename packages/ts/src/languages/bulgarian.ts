import type { LanguageModule } from '../types/language'

function stem(word: string): string {
  let len = word.length
  if (len < 4) return word

  if (len > 5 && word.endsWith('ища')) {
    word = word.slice(0, -3)
    len = word.length
  }

  if (len > 6 && word.endsWith('ият')) {
    word = word.slice(0, -3)
    len = word.length
  } else if (
    len > 5 &&
    (word.endsWith('ът') || word.endsWith('то') || word.endsWith('те') || word.endsWith('та') || word.endsWith('ия'))
  ) {
    word = word.slice(0, -2)
    len = word.length
  } else if (len > 4 && word.endsWith('ят')) {
    word = word.slice(0, -2)
    len = word.length
  }

  if (len > 6 && word.endsWith('овци')) {
    word = word.slice(0, -3)
    len = word.length
  } else if (len > 6 && word.endsWith('ове')) {
    word = word.slice(0, -3)
    len = word.length
  } else if (len > 6 && word.endsWith('еве')) {
    word = `${word.slice(0, -3)}й`
    len = word.length
  } else if (len > 5 && word.endsWith('ища')) {
    word = word.slice(0, -3)
    len = word.length
  } else if (len > 5 && word.endsWith('та')) {
    word = word.slice(0, -2)
    len = word.length
  } else if (len > 5 && word.endsWith('ци')) {
    word = `${word.slice(0, -2)}к`
    len = word.length
  } else if (len > 5 && word.endsWith('зи')) {
    word = `${word.slice(0, -2)}г`
    len = word.length
  } else if (len > 5 && word.length >= 3 && word[word.length - 1] === 'и' && word[word.length - 3] === 'е') {
    word = `${word.slice(0, -3)}я${word.slice(-2, -1)}`
    len = word.length
  } else if (len > 4 && word.endsWith('си')) {
    word = `${word.slice(0, -2)}х`
    len = word.length
  } else if (len > 4 && word.endsWith('и')) {
    word = word.slice(0, -1)
    len = word.length
  }

  if (len > 3 && (word.endsWith('я') || word.endsWith('а') || word.endsWith('о') || word.endsWith('е'))) {
    word = word.slice(0, -1)
    len = word.length
  }

  if (len > 4 && word.endsWith('ен')) {
    word = `${word.slice(0, -2)}н`
    len = word.length
  }

  if (len > 5 && word[word.length - 2] === 'ъ') {
    word = `${word.slice(0, -2)}${word[word.length - 1]}`
  }

  return word
}

const stopWords = new Set([
  'а',
  'автентичен',
  'аз',
  'ако',
  'ала',
  'бе',
  'без',
  'беше',
  'би',
  'бивш',
  'бивша',
  'бившо',
  'бил',
  'била',
  'били',
  'било',
  'благодаря',
  'близо',
  'бъдат',
  'бъде',
  'бяха',
  'в',
  'вас',
  'ваш',
  'ваша',
  'вероятно',
  'вече',
  'взема',
  'ви',
  'вие',
  'винаги',
  'внимава',
  'време',
  'все',
  'всеки',
  'всички',
  'всичко',
  'всяка',
  'във',
  'въпреки',
  'върху',
  'г',
  'ги',
  'главен',
  'главна',
  'главно',
  'глас',
  'го',
  'година',
  'години',
  'годишен',
  'д',
  'да',
  'дали',
  'два',
  'двама',
  'двамата',
  'две',
  'двете',
  'ден',
  'днес',
  'дни',
  'до',
  'добра',
  'добре',
  'добро',
  'добър',
  'докато',
  'докога',
  'дори',
  'досега',
  'доста',
  'друг',
  'друга',
  'други',
  'е',
  'евтин',
  'едва',
  'един',
  'една',
  'еднаква',
  'еднакви',
  'еднакъв',
  'едно',
  'екип',
  'ето',
  'живот',
  'за',
  'забавям',
  'зад',
  'заедно',
  'заради',
  'засега',
  'заспал',
  'затова',
  'защо',
  'защото',
  'и',
  'из',
  'или',
  'им',
  'има',
  'имат',
  'иска',
  'й',
  'каза',
  'как',
  'каква',
  'какво',
  'както',
  'какъв',
  'като',
  'кога',
  'когато',
  'което',
  'които',
  'кой',
  'който',
  'колко',
  'която',
  'къде',
  'където',
  'към',
  'лесен',
  'лесно',
  'ли',
  'лош',
  'м',
  'май',
  'малко',
  'ме',
  'между',
  'мек',
  'мен',
  'месец',
  'ми',
  'много',
  'мнозина',
  'мога',
  'могат',
  'може',
  'мокър',
  'моля',
  'момента',
  'му',
  'н',
  'на',
  'над',
  'назад',
  'най',
  'направи',
  'напред',
  'например',
  'нас',
  'не',
  'него',
  'нещо',
  'нея',
  'ни',
  'ние',
  'никой',
  'нито',
  'нищо',
  'но',
  'нов',
  'нова',
  'нови',
  'новина',
  'някои',
  'някой',
  'няколко',
  'няма',
  'обаче',
  'около',
  'освен',
  'особено',
  'от',
  'отгоре',
  'отново',
  'още',
  'пак',
  'по',
  'повече',
  'повечето',
  'под',
  'поне',
  'поради',
  'после',
  'почти',
  'прави',
  'пред',
  'преди',
  'през',
  'при',
  'пък',
  'първата',
  'първи',
  'първо',
  'пъти',
  'равен',
  'равна',
  'с',
  'са',
  'сам',
  'само',
  'се',
  'сега',
  'си',
  'син',
  'скоро',
  'след',
  'следващ',
  'сме',
  'смях',
  'според',
  'сред',
  'срещу',
  'сте',
  'съм',
  'със',
  'също',
  'т',
  'тази',
  'така',
  'такива',
  'такъв',
  'там',
  'твой',
  'те',
  'тези',
  'ти',
  'то',
  'това',
  'тогава',
  'този',
  'той',
  'толкова',
  'точно',
  'три',
  'трябва',
  'тук',
  'тъй',
  'тя',
  'тях',
  'у',
  'утре',
  'харесва',
  'хиляди',
  'ч',
  'часа',
  'че',
  'често',
  'чрез',
  'ще',
  'щом',
  'юмрук',
  'я',
  'як',
])

export const bulgarian: LanguageModule = {
  name: 'bulgarian',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9а-яъ]+/gi },
}
