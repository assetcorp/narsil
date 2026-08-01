import { azerbaijani } from '../../../languages/azerbaijani'
import { defineLanguageFixture } from './types'

const AZ_LANGUAGE = "Azerbaijani Wikipedia, article 'Azərbaycan dili' (https://az.wikipedia.org/wiki/Azərbaycan_dili)"

export const azerbaijaniFixture = defineLanguageFixture({
  module: azerbaijani,
  samples: [
    {
      text: 'Azərbaycan dili, Azərbaycan türkcəsi, azəri türkcəsi və ya azəri dili — Azərbaycan Respublikasının və Rusiya Federasiyası Dağıstan Respublikasının rəsmi dövlət dili.',
      source: AZ_LANGUAGE,
    },
    {
      text: 'Türk dilləri ailəsinin oğuz sinfinin qərb qrupuna daxildir.',
      source: AZ_LANGUAGE,
    },
  ],
  indivisible: ['azərbaycan', 'türkcəsi', 'dövlət', 'oğuz', 'üçün', 'çünki'],
  separates: [
    {
      text: 'Türk dilləri ailəsinin oğuz sinfinin',
      tokens: ['türk', 'dilləri', 'ailəsinin', 'oğuz', 'sinfinin'],
    },
    {
      text: 'rəsmi dövlət dili',
      tokens: ['rəsmi', 'dövlət', 'dili'],
    },
  ],
  equivalent: [['Azərbaycan', 'azərbaycan']],
  retrievable: [
    {
      query: 'dövlət',
      text: 'Azərbaycan dili, Azərbaycan türkcəsi, azəri türkcəsi və ya azəri dili — Azərbaycan Respublikasının və Rusiya Federasiyası Dağıstan Respublikasının rəsmi dövlət dili.',
    },
    {
      query: 'oğuz',
      text: 'Türk dilləri ailəsinin oğuz sinfinin qərb qrupuna daxildir.',
    },
  ],
})
