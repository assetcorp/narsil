import { malagasy } from '../../../languages/malagasy'
import { defineLanguageFixture } from './types'

const MG_LANGUAGE = "Malagasy Wikipedia, article 'Fiteny malagasy' (https://mg.wikipedia.org/wiki/Fiteny_malagasy)"

export const malagasyFixture = defineLanguageFixture({
  module: malagasy,
  samples: [
    {
      text: "Ny fiteny malagasy dia fiteny ao amin'ny vondrom-piteny baritô, anisan'ny fiteny aostrôneziana sy fitohizam-pitenim-paritra ampiasaina indrindra eto Madagasikara.",
      source: MG_LANGUAGE,
    },
    {
      text: "Ny karazany mahazatra, antsoina hoe \"malagasy ôfisialy\", no fiteny ôfisialin'ny Repoblikan'i Madagasikara, miaraka amin' ny fiteny frantsay.",
      source: MG_LANGUAGE,
    },
  ],
  indivisible: ['malagasy', 'baritô', 'madagasikara', 'aostrôneziana'],
  separates: [
    {
      text: "amin'ny vondrom-piteny baritô",
      tokens: ['amin', 'ny', 'vondrom', 'piteny', 'baritô'],
    },
    {
      text: 'ampiasaina indrindra eto Madagasikara',
      tokens: ['ampiasaina', 'indrindra', 'eto', 'madagasikara'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'baritô',
      text: "Ny fiteny malagasy dia fiteny ao amin'ny vondrom-piteny baritô, anisan'ny fiteny aostrôneziana sy fitohizam-pitenim-paritra ampiasaina indrindra eto Madagasikara.",
    },
    {
      query: 'frantsay',
      text: "Ny karazany mahazatra, antsoina hoe \"malagasy ôfisialy\", no fiteny ôfisialin'ny Repoblikan'i Madagasikara, miaraka amin' ny fiteny frantsay.",
    },
  ],
})
