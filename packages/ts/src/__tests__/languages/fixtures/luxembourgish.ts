import { luxembourgish } from '../../../languages/luxembourgish'
import { defineLanguageFixture } from './types'

const LB_LANGUAGE = "Luxembourgish Wikipedia, article 'Lëtzebuergesch' (https://lb.wikipedia.org/wiki/Lëtzebuergesch)"

export const luxembourgishFixture = defineLanguageFixture({
  module: luxembourgish,
  samples: [
    {
      text: "D'Lëtzebuergesch gëtt an der däitscher Dialektologie als ee westgermaneschen, mëtteldäitschen Dialekt aklasséiert, deen zum Muselfränkesche gehéiert.",
      source: LB_LANGUAGE,
    },
    {
      text: 'An der Linguistik gëtt et och alt zu de sougenannten "Ausbausproochen", respektiv "Kultursproochen", gezielt.',
      source: LB_LANGUAGE,
    },
  ],
  indivisible: ['lëtzebuergesch', 'däitscher', 'gehéiert', 'aklasséiert'],
  separates: [
    {
      text: 'deen zum Muselfränkesche gehéiert',
      tokens: ['deen', 'zum', 'muselfränkesche', 'gehéiert'],
    },
    {
      text: "D'Lëtzebuergesch gëtt an der däitscher Dialektologie",
      tokens: ['d', 'lëtzebuergesch', 'gëtt', 'an', 'der', 'däitscher', 'dialektologie'],
    },
  ],
  equivalent: [['Lëtzebuergesch', 'lëtzebuergesch']],
  retrievable: [
    {
      query: 'dialektologie',
      text: "D'Lëtzebuergesch gëtt an der däitscher Dialektologie als ee westgermaneschen, mëtteldäitschen Dialekt aklasséiert, deen zum Muselfränkesche gehéiert.",
    },
    {
      query: 'linguistik',
      text: 'An der Linguistik gëtt et och alt zu de sougenannten "Ausbausproochen", respektiv "Kultursproochen", gezielt.',
    },
  ],
})
