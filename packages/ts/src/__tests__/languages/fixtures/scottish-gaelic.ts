import { scottishGaelic } from '../../../languages/scottish-gaelic'
import { defineLanguageFixture } from './types'

const GD_LANGUAGE = "Scottish Gaelic Wikipedia, article 'Gàidhlig' (https://gd.wikipedia.org/wiki/Gàidhlig)"

export const scottishGaelicFixture = defineLanguageFixture({
  module: scottishGaelic,
  samples: [
    {
      text: "'S i cànan dùthchasach na h-Alba a th' anns a' Ghàidhlig.",
      source: GD_LANGUAGE,
    },
    {
      text: "'S i ball den teaghlach de chànanan Ceilteach dhen mheur Ghoidhealach a tha anns a' Ghàidhlig.",
      source: GD_LANGUAGE,
    },
  ],
  indivisible: ['dùthchasach', 'cànan', 'a-steach', 'teaghlach', 'lèir'],
  separates: [
    {
      text: 'cànan dùthchasach na h-Alba',
      tokens: ['cànan', 'dùthchasach', 'na', 'h-alba'],
    },
    {
      text: "anns a' Ghàidhlig",
      tokens: ['anns', "a'", 'ghàidhlig'],
    },
  ],
  equivalent: [
    ['Gàidhlig', 'gàidhlig'],
    ["th'", 'th’'],
  ],
  retrievable: [
    {
      query: 'dùthchasach',
      text: "'S i cànan dùthchasach na h-Alba a th' anns a' Ghàidhlig.",
    },
    {
      query: 'teaghlach',
      text: "'S i ball den teaghlach de chànanan Ceilteach dhen mheur Ghoidhealach a tha anns a' Ghàidhlig.",
    },
  ],
})
