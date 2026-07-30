import { breton } from '../../../languages/breton'
import { defineLanguageFixture } from './types'

const BR_LANGUAGE = "Breton Wikipedia, article 'Brezhoneg' (https://br.wikipedia.org/wiki/Brezhoneg)"

export const bretonFixture = defineLanguageFixture({
  module: breton,
  samples: [
    {
      text: "Ur yezh keltiek a orin eus Enez Vreizh (Breizh-Veur/Preden) hag eus skourr ar yezhoù predenek eo ar brezhoneg, pe ar breton e lec'hioù zo.",
      source: BR_LANGUAGE,
    },
    {
      text: 'A-gozh e vez komzet ha skrivet e Breizh.',
      source: BR_LANGUAGE,
    },
  ],
  indivisible: ['brezhoneg', 'yezhoù', "lec'hioù", 'kêr', 'amañ'],
  separates: [
    {
      text: 'komzet ha skrivet e Breizh',
      tokens: ['komzet', 'ha', 'skrivet', 'e', 'breizh'],
    },
    {
      text: "ar breton e lec'hioù zo",
      tokens: ['ar', 'breton', 'e', "lec'hioù", 'zo'],
    },
  ],
  equivalent: [
    ['Brezhoneg', 'brezhoneg'],
    ["lec'hioù", 'lec’hioù'],
  ],
  retrievable: [
    {
      query: 'brezhoneg',
      text: "Ur yezh keltiek a orin eus Enez Vreizh (Breizh-Veur/Preden) hag eus skourr ar yezhoù predenek eo ar brezhoneg, pe ar breton e lec'hioù zo.",
    },
    {
      query: 'skrivet',
      text: 'A-gozh e vez komzet ha skrivet e Breizh.',
    },
  ],
})
