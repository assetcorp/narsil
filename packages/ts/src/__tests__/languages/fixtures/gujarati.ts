import { gujarati } from '../../../languages/gujarati'
import { defineLanguageFixture } from './types'

const GU_LANGUAGE = "Gujarati Wikipedia, article 'ગુજરાતી ભાષા' (https://gu.wikipedia.org/wiki/ગુજરાતી_ભાષા)"

export const gujaratiFixture = defineLanguageFixture({
  module: gujarati,
  samples: [
    {
      text: 'ગુજરાતીનો ઉદ્ભવ જૂની ગુજરાતી ભાષા માંથી થયો છે.',
      source: GU_LANGUAGE,
    },
    {
      text: 'તે ગુજરાત રાજ્ય અને દીવ, દમણ અને દાદરા-નગર હવેલી કેન્દ્રશાસિત પ્રદેશોની અધિકૃત ભાષા છે.',
      source: GU_LANGUAGE,
    },
  ],
  indivisible: ['ગુજરાતી', 'ઉદ્ભવ', 'કેન્દ્રશાસિત', 'પ્રદેશોની'],
  separates: [
    {
      text: 'જૂની ગુજરાતી ભાષા માંથી થયો છે',
      tokens: ['જૂની', 'ગુજરાતી', 'ભાષા', 'માંથી', 'થયો', 'છે'],
    },
    {
      text: 'દાદરા-નગર હવેલી',
      tokens: ['દાદરા', 'નગર', 'હવેલી'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'ઉદ્ભવ',
      text: 'ગુજરાતીનો ઉદ્ભવ જૂની ગુજરાતી ભાષા માંથી થયો છે.',
    },
    {
      query: 'કેન્દ્રશાસિત',
      text: 'તે ગુજરાત રાજ્ય અને દીવ, દમણ અને દાદરા-નગર હવેલી કેન્દ્રશાસિત પ્રદેશોની અધિકૃત ભાષા છે.',
    },
  ],
})
