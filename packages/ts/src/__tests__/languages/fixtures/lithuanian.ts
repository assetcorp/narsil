import { lithuanian } from '../../../languages/lithuanian'
import { defineLanguageFixture } from './types'

const LT_LANGUAGE = "Lithuanian Wikipedia, article 'Lietuvių kalba' (https://lt.wikipedia.org/wiki/Lietuvių_kalba)"

export const lithuanianFixture = defineLanguageFixture({
  module: lithuanian,
  samples: [
    {
      text: 'Lietuviškai kalba apie tris milijonus žmonių.',
      source: LT_LANGUAGE,
    },
    {
      text: 'Drauge su latvių, mirusiomis prūsų, jotvingių ir kitomis baltų kalbomis priklauso indoeuropiečių kalbų šeimos baltų kalbų grupei.',
      source: LT_LANGUAGE,
    },
  ],
  indivisible: ['lietuviškai', 'žmonių', 'indoeuropiečių', 'šeimos'],
  separates: [
    {
      text: 'Lietuviškai kalba apie tris milijonus žmonių',
      tokens: ['lietuviškai', 'kalba', 'apie', 'tris', 'milijonus', 'žmonių'],
    },
    {
      text: 'priklauso indoeuropiečių kalbų šeimos baltų kalbų grupei',
      tokens: ['priklauso', 'indoeuropiečių', 'kalbų', 'šeimos', 'baltų', 'kalbų', 'grupei'],
    },
  ],
  equivalent: [['Lietuvių', 'lietuvių']],
  retrievable: [
    {
      query: 'milijonus',
      text: 'Lietuviškai kalba apie tris milijonus žmonių.',
    },
    {
      query: 'indoeuropiečių',
      text: 'Drauge su latvių, mirusiomis prūsų, jotvingių ir kitomis baltų kalbomis priklauso indoeuropiečių kalbų šeimos baltų kalbų grupei.',
    },
  ],
})
