import { tatar } from '../../../languages/tatar'
import { defineLanguageFixture } from './types'

const TT_LANGUAGE = "Tatar Wikipedia, article 'Татар теле' (https://tt.wikipedia.org/wiki/Татар_теле)"

export const tatarFixture = defineLanguageFixture({
  module: tatar,
  samples: [
    {
      text: 'Татар теле — татарларның милли теле, Татарстанның дәүләт теле, таралышы буенча Россиядә икенче тел.',
      source: TT_LANGUAGE,
    },
    {
      text: 'Төрки телләрнең кыпчак төркеменә керә.',
      source: TT_LANGUAGE,
    },
  ],
  indivisible: ['татарларның', 'дәүләт', 'төрки', 'җир', 'һәм'],
  separates: [
    {
      text: 'Татарстанның дәүләт теле',
      tokens: ['татарстанның', 'дәүләт', 'теле'],
    },
    {
      text: 'Төрки телләрнең кыпчак төркеменә керә',
      tokens: ['төрки', 'телләрнең', 'кыпчак', 'төркеменә', 'керә'],
    },
  ],
  equivalent: [['Татар', 'татар']],
  retrievable: [
    {
      query: 'дәүләт',
      text: 'Татар теле — татарларның милли теле, Татарстанның дәүләт теле, таралышы буенча Россиядә икенче тел.',
    },
    {
      query: 'кыпчак',
      text: 'Төрки телләрнең кыпчак төркеменә керә.',
    },
  ],
})
