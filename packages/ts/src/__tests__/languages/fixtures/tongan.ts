import { tongan } from '../../../languages/tongan'
import { defineLanguageFixture } from './types'

const TO_LANGUAGE = "Tongan Wikipedia, article 'Lea fakatonga' (https://to.wikipedia.org/wiki/Lea_fakatonga)"
const TO_TONGA = "Tongan Wikipedia, article 'Tonga' (https://to.wikipedia.org/wiki/Tonga)"

export const tonganFixture = defineLanguageFixture({
  module: tongan,
  samples: [
    {
      text: 'Ko e lea fakatonga ʻoku ʻilo ʻe he kakai Tonga ʻe tokotaha kilu tupu mo e kakai Tonga nofo ʻi Nuʻu Sila, ʻAmelika mo e hā fua, ʻe tokolahi mano tupu.',
      source: TO_LANGUAGE,
    },
    {
      text: "Ko Tongá pe ko e Pule'anga Fakatu'i 'o Tongá ko ha 'otu motu 'oku tu'u 'i he Moana Pasifiki Tonga",
      source: TO_TONGA,
    },
  ],
  indivisible: ['fakatonga', 'tokolahi', 'kilomita', 'vahevahe'],
  separates: [
    {
      text: 'Ko e lea fakatonga',
      tokens: ['ko', 'e', 'lea', 'fakatonga'],
    },
    {
      text: "'oku tu'u 'i he Moana Pasifiki",
      tokens: ["'oku", "tu'u", "'i", 'he', 'moana', 'pasifiki'],
    },
  ],
  equivalent: [['ʻoku', "'oku"]],
  retrievable: [
    {
      query: 'fakatonga',
      text: 'Ko e lea fakatonga ʻoku ʻilo ʻe he kakai Tonga ʻe tokotaha kilu tupu mo e kakai Tonga nofo ʻi Nuʻu Sila, ʻAmelika mo e hā fua, ʻe tokolahi mano tupu.',
    },
    {
      query: 'pasifiki',
      text: "Ko Tongá pe ko e Pule'anga Fakatu'i 'o Tongá ko ha 'otu motu 'oku tu'u 'i he Moana Pasifiki Tonga",
    },
  ],
})
