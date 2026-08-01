import { marathi } from '../../../languages/marathi'
import { defineLanguageFixture } from './types'

const MR_LANGUAGE = "Marathi Wikipedia, article 'महाराष्ट्र' (https://mr.wikipedia.org/wiki/महाराष्ट्र)"

export const marathiFixture = defineLanguageFixture({
  module: marathi,
  samples: [
    {
      text: 'महाराष्ट्र हे भारताच्या पश्चिम भागातले एक राज्य आहे.',
      source: MR_LANGUAGE,
    },
    {
      text: 'क्षेत्रफळाच्या दृष्टीने महाराष्ट्र भारतातील तिसरे व लोकसंख्येच्या बाबतीत दुसरे मोठे राज्य आहे.',
      source: MR_LANGUAGE,
    },
  ],
  indivisible: ['महाराष्ट्र', 'क्षेत्रफळाच्या', 'लोकसंख्येच्या', 'राजधानी'],
  separates: [
    {
      text: 'भारताच्या पश्चिम भागातले एक राज्य आहे',
      tokens: ['भारताच्या', 'पश्चिम', 'भागातले', 'एक', 'राज्य', 'आहे'],
    },
    {
      text: 'महाराष्ट्राची राजधानी मुंबई आहे',
      tokens: ['महाराष्ट्राची', 'राजधानी', 'मुंबई', 'आहे'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'पश्चिम',
      text: 'महाराष्ट्र हे भारताच्या पश्चिम भागातले एक राज्य आहे.',
    },
    {
      query: 'लोकसंख्येच्या',
      text: 'क्षेत्रफळाच्या दृष्टीने महाराष्ट्र भारतातील तिसरे व लोकसंख्येच्या बाबतीत दुसरे मोठे राज्य आहे.',
    },
  ],
})
