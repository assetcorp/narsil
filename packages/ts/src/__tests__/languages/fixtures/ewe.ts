import { ewe } from '../../../languages/ewe'
import { defineLanguageFixture } from './types'

export const eweFixture = defineLanguageFixture({
  module: ewe,
  samples: [
    {
      text: 'Eʋenyigba de lolo ge abe Asãte kple Dahome, siwo le eƒe goawo kple eve dzi, ene.',
      source: "Ewe Wikipedia, article 'Eʋegbe' (data/processed/wikipedia/wikipedia-ee.json)",
    },
    {
      text: 'Ephraim Kɔku Amu nye Ghana hakpalawo ta tɔ ɖeka kpakple nufiala.',
      source: "Ewe Wikipedia, article 'Ephraim Amu' (data/processed/wikipedia/wikipedia-ee.json)",
    },
    {
      text: 'Akowo ɖua nukuwo, seƒoƒowo kple nutsetsewo.',
      source: "Ewe Wikipedia, article 'Ako' (data/processed/wikipedia/wikipedia-ee.json)",
    },
  ],
  indivisible: ['eʋegbe', 'eʋe', 'eƒe', 'seƒoƒowo', 'aʋa', 'ɖeka', 'kɔku', 'asãte'],
  separates: [
    { text: 'eʋegbe kple eƒe', tokens: ['eʋegbe', 'kple', 'eƒe'] },
    { text: 'Gana ƒe fiadzue nye Accra.', tokens: ['gana', 'ƒe', 'fiadzue', 'nye', 'accra'] },
  ],
  equivalent: [
    ['ɖeka', 'ðeka'],
    ['Eʋegbe', 'eʋegbe'],
  ],
  retrievable: [
    { query: 'eʋegbe', text: 'Eʋegbe nye gbe si wodona le Ghana kple Togo.' },
    { query: 'seƒoƒowo', text: 'Akowo ɖua nukuwo, seƒoƒowo kple nutsetsewo.' },
  ],
})
