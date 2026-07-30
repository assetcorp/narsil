import { latin } from '../../../languages/latin'
import { defineLanguageFixture } from './types'

const LA_LANGUAGE = "Latin Wikipedia, article 'Lingua Latina' (https://la.wikipedia.org/wiki/Lingua_Latina)"

export const latinFixture = defineLanguageFixture({
  module: latin,
  samples: [
    {
      text: 'Latīnum, lingua Latīna, sive sermō Latīnus, est lingua Indoeuropaea qua primum Latini universi et Romani antiqui in primis loquebantur quamobrem interdum etiam lingua Latia et lingua Rōmāna appellabatur.',
      source: LA_LANGUAGE,
    },
    {
      text: 'Nomen linguae ductum est a terra quam gentes Latine loquentes incolebant, Latium vetus interdum appellata, in paeninsula Italica inter Tiberim, Volscos, Appenninum, et mare Inferum sita.',
      source: LA_LANGUAGE,
    },
  ],
  indivisible: ['linguae', 'appellabatur', 'paeninsula', 'loquebantur'],
  separates: [
    {
      text: 'lingua Latīna, sive sermō Latīnus',
      tokens: ['lingua', 'latina', 'sive', 'sermo', 'latinus'],
    },
    {
      text: 'Nomen linguae ductum est',
      tokens: ['nomen', 'linguae', 'ductum', 'est'],
    },
  ],
  equivalent: [
    ['Latīnum', 'latinum'],
    ['Rōmāna', 'romana'],
    ['rēs', 'res'],
    ['ūnus', 'unus'],
    ['tē', 'te'],
  ],
  retrievable: [
    {
      query: 'loquebantur',
      text: 'Latīnum, lingua Latīna, sive sermō Latīnus, est lingua Indoeuropaea qua primum Latini universi et Romani antiqui in primis loquebantur quamobrem interdum etiam lingua Latia et lingua Rōmāna appellabatur.',
    },
    {
      query: 'paeninsula',
      text: 'Nomen linguae ductum est a terra quam gentes Latine loquentes incolebant, Latium vetus interdum appellata, in paeninsula Italica inter Tiberim, Volscos, Appenninum, et mare Inferum sita.',
    },
  ],
})
