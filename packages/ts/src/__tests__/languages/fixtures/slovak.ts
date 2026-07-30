import { slovak } from '../../../languages/slovak'
import { defineLanguageFixture } from './types'

const SK_LANGUAGE = "Slovak Wikipedia, article 'Slovenčina' (https://sk.wikipedia.org/wiki/Slovenčina)"
const SK_BRATISLAVA = "Slovak Wikipedia, article 'Bratislava' (https://sk.wikipedia.org/wiki/Bratislava)"

export const slovakFixture = defineLanguageFixture({
  module: slovak,
  samples: [
    {
      text: 'Slovenčina patrí do skupiny západoslovanských jazykov.',
      source: SK_LANGUAGE,
    },
    {
      text: 'Bratislava je súčasťou širšieho bratislavského metropolitného regiónu, ktorý zahŕňa približne 1,3 milióna obyvateľov.',
      source: SK_BRATISLAVA,
    },
  ],
  indivisible: ['slovenčina', 'súčasťou', 'zahŕňa', 'stĺp', 'najväčšie', 'obyvateľov'],
  separates: [
    {
      text: 'Slovenčina patrí do skupiny západoslovanských jazykov',
      tokens: ['slovenčina', 'patrí', 'do', 'skupiny', 'západoslovanských', 'jazykov'],
    },
    {
      text: 'ktorý zahŕňa približne',
      tokens: ['ktorý', 'zahŕňa', 'približne'],
    },
  ],
  equivalent: [['Slovenčina', 'slovenčina']],
  retrievable: [
    {
      query: 'západoslovanských',
      text: 'Slovenčina patrí do skupiny západoslovanských jazykov.',
    },
    {
      query: 'metropolitného',
      text: 'Bratislava je súčasťou širšieho bratislavského metropolitného regiónu, ktorý zahŕňa približne 1,3 milióna obyvateľov.',
    },
  ],
})
