import { polish } from '../../../languages/polish'
import { defineLanguageFixture } from './types'

const PL_LANGUAGE = "Polish Wikipedia, article 'Język polski' (https://pl.wikipedia.org/wiki/Język_polski)"

export const polishFixture = defineLanguageFixture({
  module: polish,
  samples: [
    {
      text: 'Język polski, polszczyzna – język lechicki z grupy zachodniosłowiańskiej, stanowiącej część rodziny indoeuropejskiej.',
      source: PL_LANGUAGE,
    },
    {
      text: 'Jest językiem urzędowym w Polsce oraz należy do oficjalnych języków Unii Europejskiej.',
      source: PL_LANGUAGE,
    },
  ],
  indivisible: ['zachodniosłowiańskiej', 'polszczyzna', 'urzędowym', 'źródło', 'część'],
  separates: [
    {
      text: 'język lechicki z grupy zachodniosłowiańskiej',
      tokens: ['język', 'lechicki', 'z', 'grupy', 'zachodniosłowiańskiej'],
    },
    {
      text: 'Jest językiem urzędowym w Polsce',
      tokens: ['jest', 'językiem', 'urzędowym', 'w', 'polsce'],
    },
  ],
  equivalent: [
    ['Polski', 'polski'],
    ['Europejskiej', 'europejskiej'],
  ],
  retrievable: [
    {
      query: 'polszczyzna',
      text: 'Język polski, polszczyzna – język lechicki z grupy zachodniosłowiańskiej, stanowiącej część rodziny indoeuropejskiej.',
    },
    {
      query: 'urzędowym',
      text: 'Jest językiem urzędowym w Polsce oraz należy do oficjalnych języków Unii Europejskiej.',
    },
  ],
})
