import { portuguese } from '../../../languages/portuguese'
import { defineLanguageFixture } from './types'

const PT_LANGUAGE =
  "Portuguese Wikipedia, article 'Língua portuguesa' (https://pt.wikipedia.org/wiki/Língua_portuguesa)"
const PT_TREMA = "Portuguese Wikipedia, article 'Trema' (https://pt.wikipedia.org/wiki/Trema)"

export const portugueseFixture = defineLanguageFixture({
  module: portuguese,
  samples: [
    {
      text: 'Língua portuguesa, também designada português, é uma língua indo-europeia românica flexiva ocidental originada no galego-português falado no Reino da Galiza e no norte de Portugal.',
      source: PT_LANGUAGE,
    },
    {
      text: 'É importante salientar que incluído no que se convencionou chamar português do Brasil e português europeu há um grande número de variações regionais.',
      source: PT_LANGUAGE,
    },
    {
      text: 'Exemplos: qüinqüênio (pronuncia-se então "cuincuênio") e conseqüência (pronuncia-se então "consecuência").',
      source: PT_TREMA,
    },
    {
      text: 'Até a alteração promovida pela Lei 5.765/1971, o trema tinha uma utilização adicional: marcar hiatos átonos, em palavras como gaüchismo.',
      source: PT_TREMA,
    },
  ],
  indivisible: ['conseqüência', 'qüinqüênio', 'gaüchismo', 'lingüiça', 'português', 'românica'],
  separates: [
    { text: 'qüinqüênio e conseqüência', tokens: ['qüinqüênio', 'e', 'conseqüência'] },
    {
      text: 'em palavras como gaüchismo',
      tokens: ['em', 'palavras', 'como', 'gaüchismo'],
    },
  ],
  equivalent: [
    ['conseqüência', 'consequência'],
    ['Português', 'português'],
  ],
  retrievable: [
    {
      query: 'conseqüência',
      text: 'Exemplos: qüinqüênio (pronuncia-se então "cuincuênio") e conseqüência (pronuncia-se então "consecuência").',
    },
    {
      query: 'românica',
      text: 'Língua portuguesa, também designada português, é uma língua indo-europeia românica flexiva ocidental originada no galego-português falado no Reino da Galiza e no norte de Portugal.',
    },
  ],
})
