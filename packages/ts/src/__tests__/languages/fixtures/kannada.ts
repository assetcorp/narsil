import { kannada } from '../../../languages/kannada'
import { defineLanguageFixture } from './types'

const KN_LANGUAGE = "Kannada Wikipedia, article 'ಕನ್ನಡ' (https://kn.wikipedia.org/wiki/ಕನ್ನಡ)"

export const kannadaFixture = defineLanguageFixture({
  module: kannada,
  samples: [
    {
      text: 'ಕನ್ನಡ ಕರ್ನಾಟಕ ರಾಜ್ಯದ ಆಡಳಿತ ಭಾಷೆ.',
      source: KN_LANGUAGE,
    },
    {
      text: 'ಬ್ರಾಹ್ಮಿ ಲಿಪಿಯಿಂದ ರೂಪುಗೊಂಡ ಕನ್ನಡ ಲಿಪಿಯನ್ನು ಉಪಯೋಗಿಸಿ ಕನ್ನಡ ಭಾಷೆಯನ್ನು ಬರೆಯಲಾಗುತ್ತದೆ.',
      source: KN_LANGUAGE,
    },
  ],
  indivisible: ['ಕನ್ನಡ', 'ಕರ್ನಾಟಕ', 'ಬ್ರಾಹ್ಮಿ', 'ಭಾಷೆಯನ್ನು'],
  separates: [
    {
      text: 'ಕನ್ನಡ ಕರ್ನಾಟಕ ರಾಜ್ಯದ ಆಡಳಿತ ಭಾಷೆ',
      tokens: ['ಕನ್ನಡ', 'ಕರ್ನಾಟಕ', 'ರಾಜ್ಯದ', 'ಆಡಳಿತ', 'ಭಾಷೆ'],
    },
    {
      text: 'ಕನ್ನಡ ಲಿಪಿಯನ್ನು ಉಪಯೋಗಿಸಿ',
      tokens: ['ಕನ್ನಡ', 'ಲಿಪಿಯನ್ನು', 'ಉಪಯೋಗಿಸಿ'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'ಆಡಳಿತ',
      text: 'ಕನ್ನಡ ಕರ್ನಾಟಕ ರಾಜ್ಯದ ಆಡಳಿತ ಭಾಷೆ.',
    },
    {
      query: 'ಬ್ರಾಹ್ಮಿ',
      text: 'ಬ್ರಾಹ್ಮಿ ಲಿಪಿಯಿಂದ ರೂಪುಗೊಂಡ ಕನ್ನಡ ಲಿಪಿಯನ್ನು ಉಪಯೋಗಿಸಿ ಕನ್ನಡ ಭಾಷೆಯನ್ನು ಬರೆಯಲಾಗುತ್ತದೆ.',
    },
  ],
})
