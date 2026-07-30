import { kirundi } from '../../../languages/kirundi'
import { defineLanguageFixture } from './types'

const RN_LANGUAGE = "Kirundi Wikipedia, article 'Ikirundi' (https://rn.wikipedia.org/wiki/Ikirundi)"

export const kirundiFixture = defineLanguageFixture({
  module: kirundi,
  samples: [
    {
      text: "Ikirundi ni ururimi ruvugwa n'abantu barenga imiriyoni icumi.",
      source: RN_LANGUAGE,
    },
    {
      text: "Hamwe n'igifaransa, ikirundi ni ururimi rwemewe n'amategeko kandi rukoreshwa mu gihugu c'Uburundi.",
      source: RN_LANGUAGE,
    },
  ],
  indivisible: ['ikirundi', 'barenga', 'imiriyoni', 'amategeko'],
  separates: [
    {
      text: "n'abantu barenga imiriyoni icumi",
      tokens: ['n', 'abantu', 'barenga', 'imiriyoni', 'icumi'],
    },
    {
      text: "gihugu c'Uburundi",
      tokens: ['gihugu', 'c', 'uburundi'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'barenga',
      text: "Ikirundi ni ururimi ruvugwa n'abantu barenga imiriyoni icumi.",
    },
    {
      query: 'amategeko',
      text: "Hamwe n'igifaransa, ikirundi ni ururimi rwemewe n'amategeko kandi rukoreshwa mu gihugu c'Uburundi.",
    },
  ],
})
