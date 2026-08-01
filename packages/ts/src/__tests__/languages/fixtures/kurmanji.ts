import { kurmanji } from '../../../languages/kurmanji'
import { defineLanguageFixture } from './types'

const KMR_LANGUAGE = "Kurdish Wikipedia, article 'Kurmancî' (https://ku.wikipedia.org/wiki/Kurmancî)"

export const kurmanjiFixture = defineLanguageFixture({
  module: kurmanji,
  samples: [
    {
      text: 'Kurmancî, kurdiya jorîn yan jî kurdiya bakurî yek ji zaravayên zimanê kurdî ye ku li devereke berfirehê Kurdistanê tê axavtin.',
      source: KMR_LANGUAGE,
    },
    {
      text: 'Zaravaya Kurmancî li gel deverên Kurdistanê li herêmeke berfirehê Anatolyaya Navîn, li Xorasanê û li diyasporaya kurdan tê bikaranîn.',
      source: KMR_LANGUAGE,
    },
  ],
  indivisible: ['kurmancî', 'zaravayên', 'zimanê', 'axavtin', 'çend'],
  separates: [
    {
      text: 'yek ji zaravayên zimanê kurdî',
      tokens: ['yek', 'ji', 'zaravayên', 'zimanê', 'kurdî'],
    },
    {
      text: 'li diyasporaya kurdan tê bikaranîn',
      tokens: ['li', 'diyasporaya', 'kurdan', 'tê', 'bikaranîn'],
    },
  ],
  equivalent: [['Kurmancî', 'kurmancî']],
  retrievable: [
    {
      query: 'axavtin',
      text: 'Kurmancî, kurdiya jorîn yan jî kurdiya bakurî yek ji zaravayên zimanê kurdî ye ku li devereke berfirehê Kurdistanê tê axavtin.',
    },
    {
      query: 'diyasporaya',
      text: 'Zaravaya Kurmancî li gel deverên Kurdistanê li herêmeke berfirehê Anatolyaya Navîn, li Xorasanê û li diyasporaya kurdan tê bikaranîn.',
    },
  ],
})
