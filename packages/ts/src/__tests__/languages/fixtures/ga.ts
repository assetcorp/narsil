import { ga } from '../../../languages/ga'
import { defineLanguageFixture } from './types'

const GA_UDHR = 'Universal Declaration of Human Rights in Ga, United Nations OHCHR (NLTK udhr corpus, file Ga-UTF8)'

export const gaFixture = defineLanguageFixture({
  module: ga,
  samples: [
    {
      text: 'Akɛni ehe hiaa akɛ akã he aha naanyobɔɔ ahi maji ateŋ hewɔ lɛ,',
      source: GA_UDHR,
    },
    {
      text: 'Akɛni suɔmɔ ni asumɔɔɔ akɛ atsɔɔ gbɛ kroko nɔ ajieɔ yiwalɛ nɔyeli ko hewɔ ni ehiaa akɛ awo mla ni baafã gbɔmɔ adesa hegbɛi ahe hewɔ lɛ,',
      source: GA_UDHR,
    },
    {
      text: 'JEŊJEŊ KPAŊMƆ NI KƆƆ GBƆMƆ ADESA HEGBƐI AHE',
      source: GA_UDHR,
    },
  ],
  indivisible: ['gbɔmɔ', 'hegbɛi', 'jeŋjeŋ', 'naanyobɔɔ', 'akã', 'baafã', 'gbãla', 'ashɔ̃'],
  separates: [
    { text: 'akã he aha naanyobɔɔ', tokens: ['akã', 'he', 'aha', 'naanyobɔɔ'] },
    { text: 'ni baafã gbɔmɔ adesa hegbɛi', tokens: ['ni', 'baafã', 'gbɔmɔ', 'adesa', 'hegbɛi'] },
  ],
  equivalent: [['JEŊJEŊ', 'jeŋjeŋ']],
  retrievable: [
    {
      query: 'baafã',
      text: 'Akɛni suɔmɔ ni asumɔɔɔ akɛ atsɔɔ gbɛ kroko nɔ ajieɔ yiwalɛ nɔyeli ko hewɔ ni ehiaa akɛ awo mla ni baafã gbɔmɔ adesa hegbɛi ahe hewɔ lɛ,',
    },
    { query: 'hegbɛi', text: 'JEŊJEŊ KPAŊMƆ NI KƆƆ GBƆMƆ ADESA HEGBƐI AHE' },
  ],
})
