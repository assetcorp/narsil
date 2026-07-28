import { slovenian } from '../../../languages/slovenian'
import { defineLanguageFixture } from './types'

const SL_LANGUAGE = "Slovene Wikipedia, article 'Slovenščina' (https://sl.wikipedia.org/wiki/Slovenščina)"
const SL_ZDRAVLJICA = 'Slovene Wikisource, France Prešeren, Zdravljica (https://sl.wikisource.org/wiki/Zdravljica)'

export const slovenianFixture = defineLanguageFixture({
  module: slovenian,
  samples: [
    {
      text: 'Slovenščina je zahodni južnoslovanski jezik in eden redkih indoevropskih jezikov, ki je ohranil dvojino.',
      source: SL_LANGUAGE,
    },
    {
      text: 'Slovenska gajica se imenuje slovenica in v njej pišemo od marčne revolucije 1848.',
      source: SL_LANGUAGE,
    },
    {
      text: 'Za zapisovanje slovenskega jezika se danes uporablja gajica, pisava imenovana po hrvaškem jezikoslovcu Ljudevitu Gaju, ki jo je priredil po češkem črkopisu.',
      source: SL_LANGUAGE,
    },
    {
      text: 'so trte vince nam sladkó, ki nam oživlja žile, srcé razjásni in oko,',
      source: SL_ZDRAVLJICA,
    },
  ],
  indivisible: ['sladkó', 'srcé', 'razjásni', 'sinóv', 'rodú', 'otrók', 'slovenščina', 'črkopisu'],
  separates: [
    { text: 'srcé razjásni in oko', tokens: ['srce', 'razjasni', 'in', 'oko'] },
    { text: 'so trte vince nam sladkó', tokens: ['so', 'trte', 'vince', 'nam', 'sladko'] },
  ],
  equivalent: [
    ['srcé', 'srce'],
    ['Slovenščina', 'slovenščina'],
  ],
  retrievable: [
    { query: 'srcé', text: 'so trte vince nam sladkó, ki nam oživlja žile, srcé razjásni in oko,' },
    {
      query: 'črkopisu',
      text: 'Za zapisovanje slovenskega jezika se danes uporablja gajica, pisava imenovana po hrvaškem jezikoslovcu Ljudevitu Gaju, ki jo je priredil po češkem črkopisu.',
    },
  ],
})
