import { samoan } from '../../../languages/samoan'
import { defineLanguageFixture } from './types'

const SM_LANGUAGE = "Samoan Wikipedia, article 'Gagana faʻa Sāmoa' (https://sm.wikipedia.org/wiki/Gagana_faʻa_Sāmoa)"
const SM_SAMOA = "Samoan Wikipedia, article 'Sāmoa' (https://sm.wikipedia.org/wiki/Sāmoa)"

export const samoanFixture = defineLanguageFixture({
  module: samoan,
  samples: [
    {
      text: 'ʻO le gagana Sāmoa ʻo le gagana moni a Sāmoa, ʻatoa foʻi ma Amerika Sāmoa.',
      source: SM_LANGUAGE,
    },
    {
      text: 'ʻO Sāmoa, aloaia o le Malo Saʻoloto Tutoʻatasi o Sāmoa, o se atunuʻu Polenisia ʻi le vasa o le Pasefika.',
      source: SM_SAMOA,
    },
  ],
  indivisible: ['gagana', 'sāmoa', 'atunuʻu', 'pasefika'],
  separates: [
    {
      text: 'le gagana moni a Sāmoa',
      tokens: ['le', 'gagana', 'moni', 'a', 'sāmoa'],
    },
    {
      text: 'ʻatoa foʻi ma Amerika Sāmoa',
      tokens: ["'atoa", "fo'i", 'ma', 'amerika', 'sāmoa'],
    },
  ],
  equivalent: [['ʻatoa', "'atoa"]],
  retrievable: [
    {
      query: 'gagana',
      text: 'ʻO le gagana Sāmoa ʻo le gagana moni a Sāmoa, ʻatoa foʻi ma Amerika Sāmoa.',
    },
    {
      query: 'polenisia',
      text: 'ʻO Sāmoa, aloaia o le Malo Saʻoloto Tutoʻatasi o Sāmoa, o se atunuʻu Polenisia ʻi le vasa o le Pasefika.',
    },
  ],
})
