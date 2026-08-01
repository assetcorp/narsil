import { estonian } from '../../../languages/estonian'
import { defineLanguageFixture } from './types'

const ET_LANGUAGE = "Estonian Wikipedia, article 'Eesti keel' (https://et.wikipedia.org/wiki/Eesti_keel)"

export const estonianFixture = defineLanguageFixture({
  module: estonian,
  samples: [
    {
      text: 'Eesti keel on läänemeresoome lõunarühma kuuluv keel.',
      source: ET_LANGUAGE,
    },
    {
      text: 'Eesti keel on Eesti Vabariigi riigikeel ja pärast Eesti ühinemist Euroopa Liiduga 2004. aastal üks Euroopa Liidu ametlikke keeli.',
      source: ET_LANGUAGE,
    },
  ],
  indivisible: ['läänemeresoome', 'lõunarühma', 'ühinemist', 'riigikeel'],
  separates: [
    {
      text: 'Eesti keel on läänemeresoome lõunarühma kuuluv keel',
      tokens: ['eesti', 'keel', 'on', 'läänemeresoome', 'lõunarühma', 'kuuluv', 'keel'],
    },
    {
      text: 'pärast Eesti ühinemist Euroopa Liiduga',
      tokens: ['pärast', 'eesti', 'ühinemist', 'euroopa', 'liiduga'],
    },
  ],
  equivalent: [['Eesti', 'eesti']],
  retrievable: [
    {
      query: 'läänemeresoome',
      text: 'Eesti keel on läänemeresoome lõunarühma kuuluv keel.',
    },
    {
      query: 'riigikeel',
      text: 'Eesti keel on Eesti Vabariigi riigikeel ja pärast Eesti ühinemist Euroopa Liiduga 2004. aastal üks Euroopa Liidu ametlikke keeli.',
    },
  ],
})
