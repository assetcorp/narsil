import { lingala } from '../../../languages/lingala'
import { defineLanguageFixture } from './types'

const LN_LANGUAGE = "Lingala Wikipedia, article 'Lingála' (https://ln.wikipedia.org/wiki/Lingála)"

export const lingalaFixture = defineLanguageFixture({
  module: lingala,
  samples: [
    {
      text: 'Lingála ezalí lokótá la bato ba Kongó-Brazzaville mpé ba Kongó-Kinsásá, lisangá lisusu lya linɛnɛ liye lilobaka lingála lizalí na Angola na engúmba ya Luanda.',
      source: LN_LANGUAGE,
    },
    {
      text: 'Batu baye balobaka lingála na Luanda babêngami na nkómbó ya Langa Langa.',
      source: LN_LANGUAGE,
    },
  ],
  indivisible: ['lingála', 'lokótá', 'linɛnɛ', 'nkómbó'],
  separates: [
    {
      text: 'lisangá lisusu lya linɛnɛ',
      tokens: ['lisangá', 'lisusu', 'lya', 'linɛnɛ'],
    },
    {
      text: 'nkómbó ya Langa Langa',
      tokens: ['nkómbó', 'ya', 'langa', 'langa'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'lokótá',
      text: 'Lingála ezalí lokótá la bato ba Kongó-Brazzaville mpé ba Kongó-Kinsásá, lisangá lisusu lya linɛnɛ liye lilobaka lingála lizalí na Angola na engúmba ya Luanda.',
    },
    {
      query: 'nkómbó',
      text: 'Batu baye balobaka lingála na Luanda babêngami na nkómbó ya Langa Langa.',
    },
  ],
})
