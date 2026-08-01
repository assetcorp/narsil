import { esperanto } from '../../../languages/esperanto'
import { defineLanguageFixture } from './types'

const EO_LANGUAGE = "Esperanto Wikipedia, article 'Esperanto' (https://eo.wikipedia.org/wiki/Esperanto)"

export const esperantoFixture = defineLanguageFixture({
  module: esperanto,
  samples: [
    {
      text: 'Esperanto, origine la Lingvo Internacia, estas la plej disvastiĝinta internacia planlingvo.',
      source: EO_LANGUAGE,
    },
    {
      text: 'Li celis kaj sukcesis krei facile lerneblan neŭtralan lingvon, taŭgan por uzo en la internacia komunikado; la celo tamen ne estas anstataŭigi aliajn, naciajn lingvojn.',
      source: EO_LANGUAGE,
    },
  ],
  indivisible: ['disvastiĝinta', 'neŭtralan', 'planlingvo', 'ĥoro', 'ĵaŭdo', 'ŝipo', 'ĉiuj'],
  separates: [
    {
      text: 'estas la plej disvastiĝinta internacia planlingvo',
      tokens: ['estas', 'la', 'plej', 'disvastiĝinta', 'internacia', 'planlingvo'],
    },
    {
      text: 'krei facile lerneblan neŭtralan lingvon',
      tokens: ['krei', 'facile', 'lerneblan', 'neŭtralan', 'lingvon'],
    },
  ],
  equivalent: [['Esperanto', 'esperanto']],
  retrievable: [
    {
      query: 'planlingvo',
      text: 'Esperanto, origine la Lingvo Internacia, estas la plej disvastiĝinta internacia planlingvo.',
    },
    {
      query: 'neŭtralan',
      text: 'Li celis kaj sukcesis krei facile lerneblan neŭtralan lingvon, taŭgan por uzo en la internacia komunikado; la celo tamen ne estas anstataŭigi aliajn, naciajn lingvojn.',
    },
  ],
})
