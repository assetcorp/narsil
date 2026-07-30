import { kyrgyz } from '../../../languages/kyrgyz'
import { defineLanguageFixture } from './types'

const KY_LANGUAGE = "Kyrgyz Wikipedia, article 'Кыргыз тили' (https://ky.wikipedia.org/wiki/Кыргыз_тили)"

export const kyrgyzFixture = defineLanguageFixture({
  module: kyrgyz,
  samples: [
    {
      text: 'Кыргыз тили — Кыргыз Республикасынын мамлекеттик тили, түрк тилдери курамына, анын ичинде кыргыз-кыпчак же тоо-алтай тобуна кирет.',
      source: KY_LANGUAGE,
    },
    {
      text: 'Бул Кыргызстан калкынын 76% кыргыз тилинде сүйлөйт дегенди билдирет.',
      source: KY_LANGUAGE,
    },
  ],
  indivisible: ['кыргыз', 'мамлекеттик', 'түрк', 'сүйлөйт', 'көрсөтүшкөн'],
  separates: [
    {
      text: 'Кыргыз Республикасынын мамлекеттик тили',
      tokens: ['кыргыз', 'республикасынын', 'мамлекеттик', 'тили'],
    },
    {
      text: 'кыргыз тилинде сүйлөйт',
      tokens: ['кыргыз', 'тилинде', 'сүйлөйт'],
    },
  ],
  equivalent: [['Кыргыз', 'кыргыз']],
  retrievable: [
    {
      query: 'кыпчак',
      text: 'Кыргыз тили — Кыргыз Республикасынын мамлекеттик тили, түрк тилдери курамына, анын ичинде кыргыз-кыпчак же тоо-алтай тобуна кирет.',
    },
    {
      query: 'сүйлөйт',
      text: 'Бул Кыргызстан калкынын 76% кыргыз тилинде сүйлөйт дегенди билдирет.',
    },
  ],
})
