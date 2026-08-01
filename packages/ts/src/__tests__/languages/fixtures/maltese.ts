import { maltese } from '../../../languages/maltese'
import { defineLanguageFixture } from './types'

const MT_MALTA = "Maltese Wikipedia, article 'Malta' (https://mt.wikipedia.org/wiki/Malta)"

export const malteseFixture = defineLanguageFixture({
  module: maltese,
  samples: [
    {
      text: "Malta, magħrufa uffiċjalment bħala r-Repubblika ta' Malta, hija repubblika indipendenti, kostituzzjonali, żviluppata fl-Unjoni Ewropea.",
      source: MT_MALTA,
    },
    {
      text: "Il-pajjiż jikkonsisti minn arċipelagu ta' seba' gżejjer li jinsabu fil-Baħar Mediterran.",
      source: MT_MALTA,
    },
  ],
  indivisible: ['repubblika', 'uffiċjalment', 'gżejjer', 'żviluppata', 'arċipelagu'],
  separates: [
    { text: "ir-Repubblika ta' Malta", tokens: ['ir', 'repubblika', "ta'", 'malta'] },
    { text: 'fil-Baħar Mediterran', tokens: ['fil', 'baħar', 'mediterran'] },
  ],
  equivalent: [
    ['Malta', 'malta'],
    ["ta'", 'ta’'],
  ],
  retrievable: [
    {
      query: 'gżejjer',
      text: "Il-pajjiż jikkonsisti minn arċipelagu ta' seba' gżejjer li jinsabu fil-Baħar Mediterran.",
    },
    {
      query: 'mediterran',
      text: "Il-pajjiż jikkonsisti minn arċipelagu ta' seba' gżejjer li jinsabu fil-Baħar Mediterran.",
    },
  ],
})
