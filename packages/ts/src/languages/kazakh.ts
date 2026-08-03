/*
 * Stop words curated for Narsil; no published Kazakh list exists in stopwords-iso, spaCy,
 * Lucene, or the stopword npm package. Conjunctions, the postpositions, pronouns, and
 * copular forms, checked against a 123,906-character corpus of 300 random kk.wikipedia
 * articles. The Cyrillic range carries ә, ғ, қ, ң, ө, ұ, ү, һ, and і.
 * 16 of the 78 entries do not appear in that corpus: they are the first- and
 * second-person pronouns and the interrogatives that encyclopedia prose does not use.
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'аз',
  'ал',
  'арқылы',
  'бар',
  'барлығы',
  'барлық',
  'басқа',
  'бен',
  'бері',
  'бойынша',
  'болды',
  'болып',
  'болған',
  'біз',
  'біздің',
  'бір',
  'бірақ',
  'бұл',
  'да',
  'де',
  'дейін',
  'еді',
  'екен',
  'екі',
  'емес',
  'енді',
  'ең',
  'жоқ',
  'және',
  'кейін',
  'кім',
  'көп',
  'мен',
  'менің',
  'не',
  'неге',
  'немесе',
  'ол',
  'олар',
  'оларды',
  'оның',
  'осы',
  'пен',
  'сайын',
  'себебі',
  'сен',
  'сендер',
  'сенің',
  'сол',
  'сонда',
  'сондықтан',
  'соң',
  'сіз',
  'сіздер',
  'сіздің',
  'та',
  'тағы',
  'те',
  'тек',
  'туралы',
  'я',
  'ғана',
  'қазір',
  'қайда',
  'қалай',
  'қана',
  'қандай',
  'қанша',
  'қарай',
  'қашан',
  'үшін',
  'әлі',
  'әр',
  'әрбір',
  'әрі',
  'өз',
  'өзі',
  'өте',
])

/**
 * Kazakh analysis: the stop word list and the rules that split Kazakh
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `kazakh`.
 *
 * @public
 */
export const kazakh: LanguageModule = {
  name: 'kazakh',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: { splitPattern: /[^\u0400-\u04FF0-9]+/gi },
}
