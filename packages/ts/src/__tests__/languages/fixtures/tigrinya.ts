import { tigrinya } from '../../../languages/tigrinya'
import { defineLanguageFixture } from './types'

const TI_LANGUAGE = "Tigrinya Wikipedia, article 'ቋንቋ ትግርኛ' (https://ti.wikipedia.org/wiki/ቋንቋ_ትግርኛ)"

export const tigrinyaFixture = defineLanguageFixture({
  module: tigrinya,
  samples: [
    {
      text: 'ትግርኛ ኣብ ኤርትራን ኣብ ሰሜናዊ ኢትዮጵያን ኣብ ክልል ትግራይ ዝዝረብ ሴማዊ ቋንቋ እዩ።',
      source: TI_LANGUAGE,
    },
    {
      text: 'ፊደላት ትግርኛ ካብ ኣብ ስልጣኔ ኣኽሱም ዝጀመረ ፊደል ግእዝ ዝፈለቑ እዮም።',
      source: TI_LANGUAGE,
    },
  ],
  indivisible: ['ትግርኛ', 'ኤርትራን', 'ስልጣኔ', 'ፊደላት'],
  separates: [
    {
      text: 'ኣብ ክልል ትግራይ ዝዝረብ ሴማዊ ቋንቋ እዩ',
      tokens: ['ኣብ', 'ክልል', 'ትግራይ', 'ዝዝረብ', 'ሴማዊ', 'ቋንቋ', 'እዩ'],
    },
    {
      text: 'ደቂ-ሰባት',
      tokens: ['ደቂ', 'ሰባት'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'ኤርትራን',
      text: 'ትግርኛ ኣብ ኤርትራን ኣብ ሰሜናዊ ኢትዮጵያን ኣብ ክልል ትግራይ ዝዝረብ ሴማዊ ቋንቋ እዩ።',
    },
    {
      query: 'ስልጣኔ',
      text: 'ፊደላት ትግርኛ ካብ ኣብ ስልጣኔ ኣኽሱም ዝጀመረ ፊደል ግእዝ ዝፈለቑ እዮም።',
    },
  ],
})
