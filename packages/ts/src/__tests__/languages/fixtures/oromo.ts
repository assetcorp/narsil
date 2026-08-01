import { oromo } from '../../../languages/oromo'
import { defineLanguageFixture } from './types'

const OM_LANGUAGE = "Oromo Wikipedia, article 'Afaan Oromoo' (https://om.wikipedia.org/wiki/Afaan_Oromoo)"

export const oromoFixture = defineLanguageFixture({
  module: oromo,
  samples: [
    {
      text: 'Afaan Oromoo afaan Kuushii keessaa isa guddaa fi afaanota Afrikaa keessatti hedduu dubbatamu keessaa isa tokko.',
      source: OM_LANGUAGE,
    },
    {
      text: "Afaan kana ummata Oromoo fi ummattoota biro biratti namoota miliyoona 40 ol ta'an biratti dubbatama.",
      source: OM_LANGUAGE,
    },
  ],
  indivisible: ['oromoo', 'kuushii', 'ummattoota', 'afaanota'],
  separates: [
    {
      text: "ta'an biratti dubbatama",
      tokens: ["ta'an", 'biratti', 'dubbatama'],
    },
    {
      text: 'Afaan kana ummata Oromoo',
      tokens: ['afaan', 'kana', 'ummata', 'oromoo'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'kuushii',
      text: 'Afaan Oromoo afaan Kuushii keessaa isa guddaa fi afaanota Afrikaa keessatti hedduu dubbatamu keessaa isa tokko.',
    },
    {
      query: 'ummattoota',
      text: "Afaan kana ummata Oromoo fi ummattoota biro biratti namoota miliyoona 40 ol ta'an biratti dubbatama.",
    },
  ],
})
