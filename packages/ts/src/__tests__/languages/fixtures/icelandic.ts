import { icelandic } from '../../../languages/icelandic'
import { defineLanguageFixture } from './types'

const IS_LANGUAGE = "Icelandic Wikipedia, article 'Íslenska' (https://is.wikipedia.org/wiki/Íslenska)"

export const icelandicFixture = defineLanguageFixture({
  module: icelandic,
  samples: [
    {
      text: 'Íslenska er vesturnorrænt, germanskt og indóevrópskt tungumál sem er einkum talað og ritað á Íslandi og er móðurmál langflestra Íslendinga.',
      source: IS_LANGUAGE,
    },
    {
      text: 'Það hefur tekið minni breytingum frá fornnorrænu en önnur norræn mál og er skyldara norsku og færeysku en sænsku og dönsku.',
      source: IS_LANGUAGE,
    },
  ],
  indivisible: ['íslenska', 'móðurmál', 'fornnorrænu', 'nýlega'],
  separates: [
    {
      text: 'talað og ritað á Íslandi',
      tokens: ['talað', 'og', 'ritað', 'á', 'íslandi'],
    },
    {
      text: 'skyldara norsku og færeysku en sænsku og dönsku',
      tokens: ['skyldara', 'norsku', 'og', 'færeysku', 'en', 'sænsku', 'og', 'dönsku'],
    },
  ],
  equivalent: [['Íslenska', 'íslenska']],
  retrievable: [
    {
      query: 'móðurmál',
      text: 'Íslenska er vesturnorrænt, germanskt og indóevrópskt tungumál sem er einkum talað og ritað á Íslandi og er móðurmál langflestra Íslendinga.',
    },
    {
      query: 'fornnorrænu',
      text: 'Það hefur tekið minni breytingum frá fornnorrænu en önnur norræn mál og er skyldara norsku og færeysku en sænsku og dönsku.',
    },
  ],
})
