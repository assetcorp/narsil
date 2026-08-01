import { xhosa } from '../../../languages/xhosa'
import { defineLanguageFixture } from './types'

const XH_LANGUAGE = "Xhosa Wikipedia, article 'IsiXhosa' (https://xh.wikipedia.org/wiki/IsiXhosa)"

export const xhosaFixture = defineLanguageFixture({
  module: xhosa,
  samples: [
    {
      text: 'IsiXhosa lolunye lweelwimi zaseMzantsi Afrika ezingundoqo nezaziwayo.',
      source: XH_LANGUAGE,
    },
    {
      text: 'Olu lwimi lusetyenziswa kakhulu kummandla waphesheya kweNciba (Transkei) nomneno-Nciba (Ciskei), nangona kukho umahluko omncinci kwindlela yokubiza amagama athile.',
      source: XH_LANGUAGE,
    },
  ],
  indivisible: ['isixhosa', 'lweelwimi', 'ezingundoqo', 'nomneno-nciba'],
  separates: [
    {
      text: 'IsiXhosa lolunye lweelwimi zaseMzantsi Afrika',
      tokens: ['isixhosa', 'lolunye', 'lweelwimi', 'zasemzantsi', 'afrika'],
    },
    {
      text: 'kwindlela yokubiza amagama athile',
      tokens: ['kwindlela', 'yokubiza', 'amagama', 'athile'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'ezingundoqo',
      text: 'IsiXhosa lolunye lweelwimi zaseMzantsi Afrika ezingundoqo nezaziwayo.',
    },
    {
      query: 'lusetyenziswa',
      text: 'Olu lwimi lusetyenziswa kakhulu kummandla waphesheya kweNciba (Transkei) nomneno-Nciba (Ciskei), nangona kukho umahluko omncinci kwindlela yokubiza amagama athile.',
    },
  ],
})
