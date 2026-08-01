import { bosnian } from '../../../languages/bosnian'
import { defineLanguageFixture } from './types'

const BS_LANGUAGE = "Bosnian Wikipedia, article 'Bosanski jezik' (https://bs.wikipedia.org/wiki/Bosanski_jezik)"
const BS_COUNTRY =
  "Bosnian Wikipedia, article 'Bosna i Hercegovina' (https://bs.wikipedia.org/wiki/Bosna_i_Hercegovina)"

export const bosnianFixture = defineLanguageFixture({
  module: bosnian,
  samples: [
    {
      text: 'Bosanski jezik jest normativna varijanta srpskohrvatskog jezika koji koriste uglavnom Bošnjaci, ali i značajan broj ostalih osoba bosanskohercegovačkog porijekla.',
      source: BS_LANGUAGE,
    },
    {
      text: 'Bosna i Hercegovina suverena je država u jugoistočnoj Evropi, smještena na zapadu Balkanskog poluostrva.',
      source: BS_COUNTRY,
    },
  ],
  indivisible: ['bosanski', 'normativna', 'bošnjaci', 'poluostrva'],
  separates: [
    {
      text: 'značajan broj ostalih osoba',
      tokens: ['značajan', 'broj', 'ostalih', 'osoba'],
    },
    {
      text: 'suverena je država u jugoistočnoj Evropi',
      tokens: ['suverena', 'je', 'država', 'u', 'jugoistočnoj', 'evropi'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'normativna',
      text: 'Bosanski jezik jest normativna varijanta srpskohrvatskog jezika koji koriste uglavnom Bošnjaci, ali i značajan broj ostalih osoba bosanskohercegovačkog porijekla.',
    },
    {
      query: 'poluostrva',
      text: 'Bosna i Hercegovina suverena je država u jugoistočnoj Evropi, smještena na zapadu Balkanskog poluostrva.',
    },
  ],
})
