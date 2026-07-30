import { shona } from '../../../languages/shona'
import { defineLanguageFixture } from './types'

const SN_LANGUAGE = "Shona Wikipedia, article 'ChiShona' (https://sn.wikipedia.org/wiki/ChiShona)"

export const shonaFixture = defineLanguageFixture({
  module: shona,
  samples: [
    {
      text: 'Chishona, mutauro weChibantu inowanikwa kuChamhembe che Afurika munyika dzinosanganisa Zimbabwe kwairi mutauro wechihofisi uye wo, Mozambiki, Zambia, Afurika Chamhembe ne Bhotswana.',
      source: SN_LANGUAGE,
    },
    {
      text: 'Chishona chinemitauro zhinji iripedyo nayo uye nimtauro nyina inosanganisa Chindau, Chikorekore, Chikaranga, Chimanyika, Chibuja (Chibudya), Chitewe, Chitawara (Chitavara).',
      source: SN_LANGUAGE,
    },
  ],
  indivisible: ['chishona', 'mutauro', 'dzinosanganisa', 'zimbabwe'],
  separates: [
    {
      text: 'mutauro wechihofisi uye wo',
      tokens: ['mutauro', 'wechihofisi', 'uye', 'wo'],
    },
    {
      text: 'Chishona chinemitauro zhinji',
      tokens: ['chishona', 'chinemitauro', 'zhinji'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'dzinosanganisa',
      text: 'Chishona, mutauro weChibantu inowanikwa kuChamhembe che Afurika munyika dzinosanganisa Zimbabwe kwairi mutauro wechihofisi uye wo, Mozambiki, Zambia, Afurika Chamhembe ne Bhotswana.',
    },
    {
      query: 'chinemitauro',
      text: 'Chishona chinemitauro zhinji iripedyo nayo uye nimtauro nyina inosanganisa Chindau, Chikorekore, Chikaranga, Chimanyika, Chibuja (Chibudya), Chitewe, Chitawara (Chitavara).',
    },
  ],
})
