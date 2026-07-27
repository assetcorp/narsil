import { hungarian } from '../../../languages/hungarian'
import { defineLanguageFixture } from './types'

const HU_WIKIPEDIA = "Hungarian Wikipedia, article 'Magyar nyelv' (https://hu.wikipedia.org/wiki/Magyar_nyelv)"
const HU_HUNGARY = "Hungarian Wikipedia, article 'Magyarország' (https://hu.wikipedia.org/wiki/Magyarország)"

export const hungarianFixture = defineLanguageFixture({
  module: hungarian,
  samples: [
    {
      text: 'A magyar nyelv az uráli nyelvcsalád tagja, azon belül a finnugor nyelvek közé tartozó ugor nyelvek egyike.',
      source: HU_WIKIPEDIA,
    },
    {
      text: 'Legközelebbi rokonai a manysi és a hanti nyelv, majd utánuk az udmurt, a komi, a mari és a mordvin nyelvek.',
      source: HU_WIKIPEDIA,
    },
    {
      text: 'A finnugor eredetet a magyar és a nemzetközi nyelvtudomány egyaránt elfogadja.',
      source: HU_WIKIPEDIA,
    },
    {
      text: 'A magyar borvidékek sokszínűségének köszönhetően világhírű magyar termék a Tokaji aszú, az Egri bikavér és a Badacsonyi szürkebarát.',
      source: HU_HUNGARY,
    },
    {
      text: 'A vízi úthálózat hosszának 53%-a a Duna vízgyűjtő területéhez, 47%-a pedig a Tiszáéhoz tartozik.',
      source: HU_HUNGARY,
    },
  ],
  indivisible: [
    'nyelvcsalád',
    'legközelebbi',
    'nyelvtudomány',
    'egyaránt',
    'közé',
    'utánuk',
    'világhírű',
    'sokszínűségének',
    'köszönhetően',
    'aszú',
    'úthálózat',
    'vízgyűjtő',
  ],
  separates: [
    {
      text: 'A magyar nyelv az uráli nyelvcsalád tagja',
      tokens: ['a', 'magyar', 'nyelv', 'az', 'uráli', 'nyelvcsalád', 'tagja'],
    },
    {
      text: 'A finnugor eredetet a magyar és a nemzetközi nyelvtudomány egyaránt elfogadja.',
      tokens: [
        'a',
        'finnugor',
        'eredetet',
        'a',
        'magyar',
        'és',
        'a',
        'nemzetközi',
        'nyelvtudomány',
        'egyaránt',
        'elfogadja',
      ],
    },
    {
      text: 'sokszínűségének köszönhetően világhírű magyar termék',
      tokens: ['sokszínűségének', 'köszönhetően', 'világhírű', 'magyar', 'termék'],
    },
    {
      text: 'A vízi úthálózat hosszának',
      tokens: ['a', 'vízi', 'úthálózat', 'hosszának'],
    },
  ],
  equivalent: [['Magyar', 'magyar']],
  retrievable: [
    {
      query: 'nyelvcsalád',
      text: 'A magyar nyelv az uráli nyelvcsalád tagja, azon belül a finnugor nyelvek közé tartozó ugor nyelvek egyike.',
    },
    {
      query: 'nyelvtudomány',
      text: 'A finnugor eredetet a magyar és a nemzetközi nyelvtudomány egyaránt elfogadja.',
    },
    {
      query: 'világhírű',
      text: 'A magyar borvidékek sokszínűségének köszönhetően világhírű magyar termék a Tokaji aszú, az Egri bikavér és a Badacsonyi szürkebarát.',
    },
    {
      query: 'úthálózat',
      text: 'A vízi úthálózat hosszának 53%-a a Duna vízgyűjtő területéhez, 47%-a pedig a Tiszáéhoz tartozik.',
    },
  ],
})
