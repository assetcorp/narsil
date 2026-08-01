import { amharic } from '../../../languages/amharic'
import { defineLanguageFixture } from './types'

const AM_LANGUAGE = "Amharic Wikipedia, article 'አማርኛ' (https://am.wikipedia.org/wiki/አማርኛ)"

export const amharicFixture = defineLanguageFixture({
  module: amharic,
  samples: [
    {
      text: 'አማርኛ ፡ የኢትዮጵያ ፡ መደበኛ ፡ ቋንቋ ፡ ነው ።',
      source: AM_LANGUAGE,
    },
    {
      text: 'የሚጻፈውም ፡ በአማርኛ ፡ ፊደል ፡ ነው ።',
      source: AM_LANGUAGE,
    },
  ],
  indivisible: ['አማርኛ', 'የኢትዮጵያ', 'መደበኛ', 'ፊደል'],
  separates: [
    {
      text: 'አማርኛ ፡ የኢትዮጵያ ፡ መደበኛ ፡ ቋንቋ ፡ ነው',
      tokens: ['አማርኛ', 'የኢትዮጵያ', 'መደበኛ', 'ቋንቋ', 'ነው'],
    },
    {
      text: 'በአፍሪካ ፡ ከስዋሂሊ ፡ ቀጥሎ',
      tokens: ['በአፍሪካ', 'ከስዋሂሊ', 'ቀጥሎ'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'መደበኛ',
      text: 'አማርኛ ፡ የኢትዮጵያ ፡ መደበኛ ፡ ቋንቋ ፡ ነው ።',
    },
    {
      query: 'ፊደል',
      text: 'የሚጻፈውም ፡ በአማርኛ ፡ ፊደል ፡ ነው ።',
    },
  ],
})
