import { malayalam } from '../../../languages/malayalam'
import { defineLanguageFixture } from './types'

const ML_LANGUAGE = "Malayalam Wikipedia, article 'മലയാളം' (https://ml.wikipedia.org/wiki/മലയാളം)"

export const malayalamFixture = defineLanguageFixture({
  module: malayalam,
  samples: [
    {
      text: 'കേരള സംസ്ഥാനത്തിലെ ഭരണഭാഷയും കൂടിയാണ്‌ മലയാളം.',
      source: ML_LANGUAGE,
    },
    {
      text: 'പഴയ തമിഴിനും മുൻപുള്ള മൂലദ്രാവിഡമാണ് മലയാളത്തിന്റെ ആദ്യ രൂപം എന്നു കരുതുന്നു.',
      source: ML_LANGUAGE,
    },
  ],
  indivisible: ['മലയാളം', 'ദ്രാവിഡ', 'ഭരണഭാഷയും', 'മുൻപുള്ള'],
  separates: [
    {
      text: 'ആദ്യ രൂപം എന്നു കരുതുന്നു',
      tokens: ['ആദ്യ', 'രൂപം', 'എന്നു', 'കരുതുന്നു'],
    },
    {
      text: 'കേരള സംസ്ഥാനത്തിലെ ഭരണഭാഷയും കൂടിയാണ്‌ മലയാളം',
      tokens: ['കേരള', 'സംസ്ഥാനത്തിലെ', 'ഭരണഭാഷയും', 'കൂടിയാണ്', 'മലയാളം'],
    },
  ],
  equivalent: [['മുന്‍പുള്ള', 'മുൻപുള്ള']],
  retrievable: [
    {
      query: 'ഭരണഭാഷയും',
      text: 'കേരള സംസ്ഥാനത്തിലെ ഭരണഭാഷയും കൂടിയാണ്‌ മലയാളം.',
    },
    {
      query: 'മൂലദ്രാവിഡമാണ്',
      text: 'പഴയ തമിഴിനും മുൻപുള്ള മൂലദ്രാവിഡമാണ് മലയാളത്തിന്റെ ആദ്യ രൂപം എന്നു കരുതുന്നു.',
    },
  ],
})
