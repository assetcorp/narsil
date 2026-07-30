import { english } from '../../../languages/english'
import { defineLanguageFixture } from './types'

const EN_ANGOLA = "English Wikipedia, article 'Politics of Angola' (data/processed/wikipedia/wikipedia-en.json)"
const EN_AUGUST = "English Wikipedia, article 'August 27' (data/processed/wikipedia/wikipedia-en.json)"

export const englishFixture = defineLanguageFixture({
  module: english,
  samples: [
    {
      text: 'However, the election was the tightest in Angola’s history.',
      source: EN_ANGOLA,
    },
    {
      text: 'Ishida Mitsunari’s Western Army commences the Siege of Fushimi Castle, which is lightly defended by a much smaller Tokugawa garrison led by Torii Mototada.',
      source: EN_AUGUST,
    },
    {
      text: 'A Japanese fleet of 500 ships destroys Joseon commander Won Gyun’s fleet of 200 ships at Chilcheollyang.',
      source: EN_AUGUST,
    },
  ],
  indivisible: ['election', 'garrison', 'commander'],
  separates: [
    {
      text: 'However, the election was the tightest in Angola’s history.',
      tokens: ['however', 'the', 'election', 'was', 'the', 'tightest', 'in', 'angola', 'history'],
    },
    { text: "Angola's history", tokens: ['angola', 'history'] },
  ],
  equivalent: [
    ["Angola's", 'Angola’s'],
    ["don't", 'don’t'],
    ["Gyun's", 'Gyun’s'],
  ],
  retrievable: [
    { query: 'Angola', text: 'However, the election was the tightest in Angola’s history.' },
    {
      query: 'garrison',
      text: 'Ishida Mitsunari’s Western Army commences the Siege of Fushimi Castle, which is lightly defended by a much smaller Tokugawa garrison led by Torii Mototada.',
    },
  ],
})
