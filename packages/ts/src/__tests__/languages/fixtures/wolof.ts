import { wolof } from '../../../languages/wolof'
import { defineLanguageFixture } from './types'

const WO_LANGUAGE = "Wolof Wikipedia, article 'Wolof (làkk)' (https://wo.wikipedia.org/wiki/Wolof_(làkk))"

export const wolofFixture = defineLanguageFixture({
  module: wolof,
  samples: [
    {
      text: 'Wolof làkk la wu ñuy wax ci Gàmbi, Gànnaar, ak Senegaal.',
      source: WO_LANGUAGE,
    },
    {
      text: 'Mbokkoo gi mu am ak làkku pël lu yàgg la.',
      source: WO_LANGUAGE,
    },
  ],
  indivisible: ['wolof', 'làkk', 'senegaal', 'mbokkoo'],
  separates: [
    {
      text: 'Wolof làkk la wu ñuy wax',
      tokens: ['wolof', 'làkk', 'la', 'wu', 'ñuy', 'wax'],
    },
    {
      text: 'làkku pël lu yàgg',
      tokens: ['làkku', 'pël', 'lu', 'yàgg'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'senegaal',
      text: 'Wolof làkk la wu ñuy wax ci Gàmbi, Gànnaar, ak Senegaal.',
    },
    {
      query: 'mbokkoo',
      text: 'Mbokkoo gi mu am ak làkku pël lu yàgg la.',
    },
  ],
})
