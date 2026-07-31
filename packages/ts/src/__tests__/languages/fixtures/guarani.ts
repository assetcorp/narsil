import { guarani } from '../../../languages/guarani'
import { defineLanguageFixture } from './types'

const GN_LANGUAGE = "Guarani Wikipedia, article 'Avañeꞌẽ' (https://gn.wikipedia.org/wiki/Avañe'ẽ)"
const GN_COUNTRY = "Guarani Wikipedia, article 'Paraguái' (https://gn.wikipedia.org/wiki/Paraguái)"

export const guaraniFixture = defineLanguageFixture({
  module: guarani,
  samples: [
    {
      text: 'Avañeꞌẽ haꞌe ombohérava guaraninguéra iñeꞌẽ teépe.',
      source: GN_LANGUAGE,
    },
    {
      text: 'Paraguái, héra tee Tavakuairetã Paraguái, tetã oĩva Ñemby Amérika mbytéme.',
      source: GN_COUNTRY,
    },
  ],
  indivisible: ['guaraninguéra', 'iñeꞌẽ', 'tavakuairetã', 'hag̃ua'],
  separates: [
    {
      text: 'haꞌe ombohérava guaraninguéra iñeꞌẽ teépe',
      tokens: ["ha'e", 'ombohérava', 'guaraninguéra', "iñe'ẽ", 'teépe'],
    },
    {
      text: 'tetã oĩva Ñemby Amérika mbytéme',
      tokens: ['tetã', 'oĩva', 'ñemby', 'amérika', 'mbytéme'],
    },
  ],
  equivalent: [['haꞌe', "ha'e"]],
  retrievable: [
    {
      query: 'guaraninguéra',
      text: 'Avañeꞌẽ haꞌe ombohérava guaraninguéra iñeꞌẽ teépe.',
    },
    {
      query: 'tavakuairetã',
      text: 'Paraguái, héra tee Tavakuairetã Paraguái, tetã oĩva Ñemby Amérika mbytéme.',
    },
  ],
})
