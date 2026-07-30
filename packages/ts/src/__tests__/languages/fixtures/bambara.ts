import { bambara } from '../../../languages/bambara'
import { defineLanguageFixture } from './types'

const BM_LANGUAGE = "Bambara Wikipedia, article 'Bamanankan' (https://bm.wikipedia.org/wiki/Bamanankan)"
const BM_MALI = "Bambara Wikipedia, article 'Mali' (https://bm.wikipedia.org/wiki/Mali)"

export const bambaraFixture = defineLanguageFixture({
  module: bambara,
  samples: [
    {
      text: 'Bamanankan bɛ Mali kan dɔ ye.',
      source: BM_LANGUAGE,
    },
    {
      text: "Mali ye jamana ba woloflanan ye Farafina kɔnɔ, a bɛ danbɔ ni Aljeri ye saheli fɛ, Nijer kɔrɔn fɛ, Burkina Faso ani Cote d'Ivoire worodugu fɛ, Gine worodugu-tlebi, ani Senegal ni Moritani tlebi fɛ.",
      source: BM_MALI,
    },
  ],
  indivisible: ['bamanankan', 'farafina', 'kɔrɔn', 'jamana'],
  separates: [
    {
      text: 'Bamanankan bɛ Mali kan dɔ ye',
      tokens: ['bamanankan', 'bɛ', 'mali', 'kan', 'dɔ', 'ye'],
    },
    {
      text: 'Nijer kɔrɔn fɛ',
      tokens: ['nijer', 'kɔrɔn', 'fɛ'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'bamanankan',
      text: 'Bamanankan bɛ Mali kan dɔ ye.',
    },
    {
      query: 'farafina',
      text: "Mali ye jamana ba woloflanan ye Farafina kɔnɔ, a bɛ danbɔ ni Aljeri ye saheli fɛ, Nijer kɔrɔn fɛ, Burkina Faso ani Cote d'Ivoire worodugu fɛ, Gine worodugu-tlebi, ani Senegal ni Moritani tlebi fɛ.",
    },
  ],
})
