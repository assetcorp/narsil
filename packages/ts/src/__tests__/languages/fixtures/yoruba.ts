import { yoruba } from '../../../languages/yoruba'
import { defineLanguageFixture } from './types'

const YO_ABEOKUTA = "Yoruba Wikipedia, article 'Abẹ́òkúta' (data/processed/wikipedia/wikipedia-yo.json)"
const YO_OBASANJO = "Yoruba Wikipedia, article 'Olúṣẹ́gun Ọbásanjọ́' (data/processed/wikipedia/wikipedia-yo.json)"

export const yorubaFixture = defineLanguageFixture({
  module: yoruba,
  samples: [
    {
      text: 'Ìtàn Ó se pàtàkì láti mọ díẹ̀ nípa ìtàn ilẹ̀ Ẹ̀gbá àti irú ènìyàn tí ń gbé ìlú Ẹ̀gbá.',
      source: YO_ABEOKUTA,
    },
    {
      text: 'Ìdí èyí ni pé yóò jẹ́ ohun ìrànlọ́wọ́ fún ọ̀pọ̀lọpọ̀ nǹkan tó yẹ ní mímọ̀ nínú orin ògódò.',
      source: YO_ABEOKUTA,
    },
    {
      text: 'Fún ìdí pàtàkì yìí, n ó ò pín àkòrí yìí si ọ̀nà mẹ́rin ọ̀tọ̀ọ̀tọ̀.',
      source: YO_ABEOKUTA,
    },
    {
      text: 'Lẹ́yìn tí ó fẹ̀yìntì, ó bẹ̀rẹ̀ iṣẹ́ àdáṣe tirẹ̀, ìyẹn ní iṣẹ́ àgbẹ̀.',
      source: YO_OBASANJO,
    },
    {
      text: 'O jẹ akọbi awọ̀n obi re, wọn bi ọmọ mẹjọ tẹle, ṣugbon arabirin kan loni ti ò kù.',
      source: YO_OBASANJO,
    },
  ],
  indivisible: [
    'yorùbá',
    'abẹ́òkúta',
    'ọ̀pọ̀lọpọ̀',
    'nǹkan',
    'ìrànlọ́wọ́',
    'ọ̀tọ̀ọ̀tọ̀',
    'ènìyàn',
    'iṣẹ́',
    'àdáṣe',
    'ṣugbon',
    'olúṣẹ́gun',
  ],
  separates: [
    { text: 'nípa ìtàn ilẹ̀ Ẹ̀gbá', tokens: ['nípa', 'ìtàn', 'ilẹ̀', 'ẹ̀gbá'] },
    { text: 'ó bẹ̀rẹ̀ iṣẹ́ àdáṣe tirẹ̀', tokens: ['ó', 'bẹ̀rẹ̀', 'iṣẹ́', 'àdáṣe', 'tirẹ̀'] },
    {
      text: 'yóò jẹ́ ohun ìrànlọ́wọ́ fún ọ̀pọ̀lọpọ̀ nǹkan',
      tokens: ['yóò', 'jẹ́', 'ohun', 'ìrànlọ́wọ́', 'fún', 'ọ̀pọ̀lọpọ̀', 'nǹkan'],
    },
  ],
  equivalent: [
    ['Ẹ̀gbá', 'ẹ̀gbá'],
    ['Iṣẹ́', 'iṣẹ́'],
  ],
  retrievable: [
    {
      query: 'ìrànlọ́wọ́',
      text: 'Ìdí èyí ni pé yóò jẹ́ ohun ìrànlọ́wọ́ fún ọ̀pọ̀lọpọ̀ nǹkan tó yẹ ní mímọ̀ nínú orin ògódò.',
    },
    {
      query: 'ènìyàn',
      text: 'Ìtàn Ó se pàtàkì láti mọ díẹ̀ nípa ìtàn ilẹ̀ Ẹ̀gbá àti irú ènìyàn tí ń gbé ìlú Ẹ̀gbá.',
    },
    {
      query: 'iṣẹ́',
      text: 'Lẹ́yìn tí ó fẹ̀yìntì, ó bẹ̀rẹ̀ iṣẹ́ àdáṣe tirẹ̀, ìyẹn ní iṣẹ́ àgbẹ̀.',
    },
  ],
})
