import { latvian } from '../../../languages/latvian'
import { defineLanguageFixture } from './types'

const LV_LANGUAGE = "Latvian Wikipedia, article 'Latviešu valoda' (https://lv.wikipedia.org/wiki/Latviešu_valoda)"

export const latvianFixture = defineLanguageFixture({
  module: latvian,
  samples: [
    {
      text: 'Latviešu valoda ir dzimtā valoda apmēram 1,5 miljoniem cilvēku, galvenokārt Latvijā, kur tā ir vienīgā valsts valoda.',
      source: LV_LANGUAGE,
    },
    {
      text: 'Latviešu valoda pieder pie indoeiropiešu valodu saimes baltu valodu grupas.',
      source: LV_LANGUAGE,
    },
  ],
  indivisible: ['latviešu', 'vienīgā', 'ģimene', 'ķīmija', 'indoeiropiešu'],
  separates: [
    {
      text: 'Latviešu valoda ir dzimtā valoda',
      tokens: ['latviešu', 'valoda', 'ir', 'dzimtā', 'valoda'],
    },
    {
      text: 'baltu valodu grupas',
      tokens: ['baltu', 'valodu', 'grupas'],
    },
  ],
  equivalent: [['Latviešu', 'latviešu']],
  retrievable: [
    {
      query: 'miljoniem',
      text: 'Latviešu valoda ir dzimtā valoda apmēram 1,5 miljoniem cilvēku, galvenokārt Latvijā, kur tā ir vienīgā valsts valoda.',
    },
    {
      query: 'indoeiropiešu',
      text: 'Latviešu valoda pieder pie indoeiropiešu valodu saimes baltu valodu grupas.',
    },
  ],
})
