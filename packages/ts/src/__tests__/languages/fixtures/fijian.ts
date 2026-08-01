import { fijian } from '../../../languages/fijian'
import { defineLanguageFixture } from './types'

const FJ_VITI_LEVU = "Fijian Wikipedia, article 'Viti Levu' (https://fj.wikipedia.org/wiki/Viti_Levu)"
const FJ_VITI = "Fijian Wikipedia, article 'Viti' (https://fj.wikipedia.org/wiki/Viti)"

export const fijianFixture = defineLanguageFixture({
  module: fijian,
  samples: [
    {
      text: 'E dua Viti Levu sai koya na yanuyanu levu duadua ena loma ni vanua o Viti, na vanua e tiko kina na mata ni matanitu, e Suva, kei na itikotiko vei ira e vuqa sara na lewe levu ni iwiliwili nei Viti.',
      source: FJ_VITI_LEVU,
    },
    {
      text: 'Matanitu Tugalala o Viti.',
      source: FJ_VITI,
    },
  ],
  indivisible: ['yanuyanu', 'matanitu', 'tugalala', 'itikotiko'],
  separates: [
    {
      text: 'na yanuyanu levu duadua',
      tokens: ['na', 'yanuyanu', 'levu', 'duadua'],
    },
    {
      text: 'Matanitu Tugalala o Viti',
      tokens: ['matanitu', 'tugalala', 'o', 'viti'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'yanuyanu',
      text: 'E dua Viti Levu sai koya na yanuyanu levu duadua ena loma ni vanua o Viti, na vanua e tiko kina na mata ni matanitu, e Suva, kei na itikotiko vei ira e vuqa sara na lewe levu ni iwiliwili nei Viti.',
    },
    {
      query: 'tugalala',
      text: 'Matanitu Tugalala o Viti.',
    },
  ],
})
