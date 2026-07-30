import { armenian } from '../../../languages/armenian'
import { defineLanguageFixture } from './types'

const HY_WIKIPEDIA = "Armenian Wikipedia, article 'Հայերեն' (https://hy.wikipedia.org/wiki/Հայերեն)"
const HY_QUESTION_MARK =
  "Armenian Wikipedia, article 'Հարցական նշան', quoting Mikael Nalbandian (https://hy.wikipedia.org/wiki/Հարցական_նշան)"

export const armenianFixture = defineLanguageFixture({
  module: armenian,
  samples: [
    {
      text: 'Հայերեն (ավանդական՝ հայերէն), հնդեվրոպական լեզվաընտանիքի առանձին ճյուղ հանդիսացող լեզու։',
      source: HY_WIKIPEDIA,
    },
    {
      text: 'Հայաստանի և Արցախի պետական լեզուն է։',
      source: HY_WIKIPEDIA,
    },
    {
      text: 'Ի՞նչ անենք ուրեմն, ինչպե՞ս փըրկըվինք,',
      source: HY_QUESTION_MARK,
    },
  ],
  indivisible: ['հայերեն', 'լեզու', 'հայաստանի', 'ինչպես', 'ուրեմն', 'և'],
  separates: [
    { text: 'Հայաստանի և Արցախի պետական լեզուն է։', tokens: ['հայաստանի', 'և', 'արցախի', 'պետական', 'լեզուն', 'է'] },
    { text: 'Ի՞նչ անենք ուրեմն', tokens: ['ինչ', 'անենք', 'ուրեմն'] },
  ],
  equivalent: [
    ['ինչ', 'Ի՞նչ'],
    ['Հայերեն', 'հայերեն'],
  ],
  retrievable: [
    { query: 'ինչ', text: 'Ի՞նչ անենք ուրեմն, ինչպե՞ս փըրկըվինք,' },
    { query: 'հայերեն', text: 'Հայերեն, հնդեվրոպական լեզվաընտանիքի առանձին ճյուղ հանդիսացող լեզու։' },
  ],
})
