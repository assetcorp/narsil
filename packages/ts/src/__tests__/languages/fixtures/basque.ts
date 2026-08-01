import { basque } from '../../../languages/basque'
import { defineLanguageFixture } from './types'

const EU_LANGUAGE = "Basque Wikipedia, article 'Euskara' (https://eu.wikipedia.org/wiki/Euskara)"

export const basqueFixture = defineLanguageFixture({
  module: basque,
  samples: [
    {
      text: 'Euskara Euskal Herriko hizkuntza da.',
      source: EU_LANGUAGE,
    },
    {
      text: 'Hizkuntza bakartua da, ez baitzaio munduko hizkuntzen artean ahaidetasunik aurkitu.',
      source: EU_LANGUAGE,
    },
    {
      text: 'Gaur egun, Euskal Herrian bertan ere hizkuntza gutxitua da, lurralde horretan gaztelania eta frantsesa nagusitu baitira.',
      source: EU_LANGUAGE,
    },
  ],
  indivisible: ['hizkuntza', 'ahaidetasunik', 'andereño', 'gaztelania'],
  separates: [
    {
      text: 'Euskara Euskal Herriko hizkuntza da',
      tokens: ['euskara', 'euskal', 'herriko', 'hizkuntza', 'da'],
    },
    {
      text: 'gaztelania eta frantsesa nagusitu baitira',
      tokens: ['gaztelania', 'eta', 'frantsesa', 'nagusitu', 'baitira'],
    },
  ],
  equivalent: [['Euskara', 'euskara']],
  retrievable: [
    {
      query: 'ahaidetasunik',
      text: 'Hizkuntza bakartua da, ez baitzaio munduko hizkuntzen artean ahaidetasunik aurkitu.',
    },
    {
      query: 'gaztelania',
      text: 'Gaur egun, Euskal Herrian bertan ere hizkuntza gutxitua da, lurralde horretan gaztelania eta frantsesa nagusitu baitira.',
    },
  ],
})
