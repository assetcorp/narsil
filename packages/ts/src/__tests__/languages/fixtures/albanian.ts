import { albanian } from '../../../languages/albanian'
import { defineLanguageFixture } from './types'

const SQ_LANGUAGE = "Albanian Wikipedia, article 'Gjuha shqipe' (https://sq.wikipedia.org/wiki/Gjuha_shqipe)"
const SQ_ALBANIA = "Albanian Wikipedia, article 'Shqipëria' (https://sq.wikipedia.org/wiki/Shqipëria)"

export const albanianFixture = defineLanguageFixture({
  module: albanian,
  samples: [
    {
      text: 'Gjuha shqipe është gjuhë dhe degë e veçantë e familjes indo-evropiane që flitet nga rreth 15-25 milionë njerëz në botë,',
      source: SQ_LANGUAGE,
    },
    {
      text: 'Shqipëria, zyrtarisht Republika e Shqipërisë, është një shtet në Europën Juglindore.',
      source: SQ_ALBANIA,
    },
  ],
  indivisible: ['shqipe', 'veçantë', 'njerëz', 'shqipërisë', 'juglindore'],
  separates: [
    {
      text: 'flitet nga rreth',
      tokens: ['flitet', 'nga', 'rreth'],
    },
    {
      text: 'Republika e Shqipërisë',
      tokens: ['republika', 'e', 'shqipërisë'],
    },
  ],
  equivalent: [['Shqipëria', 'shqipëria']],
  retrievable: [
    {
      query: 'familjes',
      text: 'Gjuha shqipe është gjuhë dhe degë e veçantë e familjes indo-evropiane që flitet nga rreth 15-25 milionë njerëz në botë,',
    },
    {
      query: 'juglindore',
      text: 'Shqipëria, zyrtarisht Republika e Shqipërisë, është një shtet në Europën Juglindore.',
    },
  ],
})
