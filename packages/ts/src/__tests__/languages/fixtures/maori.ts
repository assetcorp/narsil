import { maori } from '../../../languages/maori'
import { defineLanguageFixture } from './types'

const MI_LANGUAGE = "Maori Wikipedia, article 'Reo Māori' (https://mi.wikipedia.org/wiki/Reo_Māori)"

export const maoriFixture = defineLanguageFixture({
  module: maori,
  samples: [
    {
      text: 'Ko te reo Māori te reo o te tangata whenua o Aotearoa.',
      source: MI_LANGUAGE,
    },
    {
      text: 'Nā te ture anō i whakamana te reo Māori hei reo a te motu o Aotearoa.',
      source: MI_LANGUAGE,
    },
  ],
  indivisible: ['māori', 'aotearoa', 'whenua', 'whakamana'],
  separates: [
    {
      text: 'te tangata whenua o Aotearoa',
      tokens: ['te', 'tangata', 'whenua', 'o', 'aotearoa'],
    },
    {
      text: 'Nā te ture anō i whakamana',
      tokens: ['nā', 'te', 'ture', 'anō', 'i', 'whakamana'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'whenua',
      text: 'Ko te reo Māori te reo o te tangata whenua o Aotearoa.',
    },
    {
      query: 'whakamana',
      text: 'Nā te ture anō i whakamana te reo Māori hei reo a te motu o Aotearoa.',
    },
  ],
})
