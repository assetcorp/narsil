import { croatian } from '../../../languages/croatian'
import { defineLanguageFixture } from './types'

const HR_LANGUAGE = "Croatian Wikipedia, article 'Hrvatski jezik' (https://hr.wikipedia.org/wiki/Hrvatski_jezik)"

export const croatianFixture = defineLanguageFixture({
  module: croatian,
  samples: [
    {
      text: 'Hrvatski jezik obuhvaća govoreni i pisani hrvatski standardni jezik i sve narodne govore kojima govore i pišu Hrvati.',
      source: HR_LANGUAGE,
    },
    {
      text: 'Status hrvatskoga kao službenoga jezika u Hrvatskoj propisan je Zakonom o hrvatskom jeziku.',
      source: HR_LANGUAGE,
    },
  ],
  indivisible: ['obuhvaća', 'službenoga', 'čovjek', 'đak', 'riječ'],
  separates: [
    {
      text: 'govoreni i pisani hrvatski standardni jezik',
      tokens: ['govoreni', 'i', 'pisani', 'hrvatski', 'standardni', 'jezik'],
    },
    {
      text: 'propisan je Zakonom o hrvatskom jeziku',
      tokens: ['propisan', 'je', 'zakonom', 'o', 'hrvatskom', 'jeziku'],
    },
  ],
  equivalent: [['Hrvatski', 'hrvatski']],
  retrievable: [
    {
      query: 'obuhvaća',
      text: 'Hrvatski jezik obuhvaća govoreni i pisani hrvatski standardni jezik i sve narodne govore kojima govore i pišu Hrvati.',
    },
    {
      query: 'propisan',
      text: 'Status hrvatskoga kao službenoga jezika u Hrvatskoj propisan je Zakonom o hrvatskom jeziku.',
    },
  ],
})
