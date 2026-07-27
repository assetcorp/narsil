import { twi } from '../../../languages/twi'
import { defineLanguageFixture } from './types'

const TW_TWI = "Twi Wikipedia, article 'Twi' (data/processed/wikipedia/wikipedia-tw.json)"
const TW_ACCRA = "Twi Wikipedia, article 'Nkran' (data/processed/wikipedia/wikipedia-tw.json)"
const TW_PARIS = "Twi Wikipedia, article 'Paris' (data/processed/wikipedia/wikipedia-tw.json)"

export const twiFixture = defineLanguageFixture({
  module: twi,
  samples: [
    {
      text: "Ɛno akyiri no, yɛwɔ abɛbuo ne kasakoa ahoroɔ a ɛwɔ sɛ obi de n'adwene kɔ akyiri ansa na w'ate aseɛ.",
      source: TW_TWI,
    },
    {
      text: 'Europa asaasepɔn so, nkuro kɛseɛ nyinaa no, Paris ni kuro kɛseɛ a ɛtɔ so nkrɔŋ.',
      source: TW_PARIS,
    },
    {
      text: 'Ɛhɔ nso na adwumakuo akɛseɛ no dodoɔ no ara wɔ.',
      source: TW_ACCRA,
    },
  ],
  indivisible: ['nkrɔŋ', 'kɛseɛ', 'adwumakuo', 'asaasepɔn', "n'adwene", "w'ate"],
  separates: [
    {
      text: 'Paris ni kuro kɛseɛ a ɛtɔ so nkrɔŋ.',
      tokens: ['paris', 'ni', 'kuro', 'kɛseɛ', 'a', 'ɛtɔ', 'so', 'nkrɔŋ'],
    },
    { text: "obi de n'adwene kɔ akyiri", tokens: ['obi', 'de', "n'adwene", 'kɔ', 'akyiri'] },
  ],
  equivalent: [
    ["n'adwene", 'n’adwene'],
    ['Nkran', 'nkran'],
  ],
  retrievable: [
    { query: 'nkrɔŋ', text: 'Europa asaasepɔn so, nkuro kɛseɛ nyinaa no, Paris ni kuro kɛseɛ a ɛtɔ so nkrɔŋ.' },
    {
      query: "n'adwene",
      text: "Ɛno akyiri no, yɛwɔ abɛbuo ne kasakoa ahoroɔ a ɛwɔ sɛ obi de n'adwene kɔ akyiri ansa na w'ate aseɛ.",
    },
  ],
})
