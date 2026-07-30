import { hawaiian } from '../../../languages/hawaiian'
import { defineLanguageFixture } from './types'

const HAW_LANGUAGE = "Hawaiian Wikipedia, article 'ʻŌlelo Hawaiʻi' (https://haw.wikipedia.org/wiki/ʻŌlelo_Hawaiʻi)"

export const hawaiianFixture = defineLanguageFixture({
  module: hawaiian,
  samples: [
    {
      text: 'ʻO ka ʻōlelo Hawaiʻi — ua mea ʻōlelo makuahine a ka poʻe maoli o ka pae moku ʻo Hawaiʻi, ma laila wale nō kahi e ʻōlelo ʻia nei ia ʻōlelo, no ka mea, ʻaʻole nui ka poʻe ʻōlelo Hawaiʻi i kēia mau lā.',
      source: HAW_LANGUAGE,
    },
    {
      text: 'He ʻōlelo kūhelu ka ʻōlelo Hawaiʻi me ka ʻōlelo Pelekania ma ka mokuʻāina ʻo Hawaiʻi wale nō.',
      source: HAW_LANGUAGE,
    },
  ],
  indivisible: ['ʻōlelo', 'hawaiʻi', 'mokuʻāina', 'kūhelu'],
  separates: [
    {
      text: 'ka ʻōlelo Hawaiʻi',
      tokens: ['ka', "'ōlelo", "hawai'i"],
    },
    {
      text: 'ma ka mokuʻāina ʻo Hawaiʻi',
      tokens: ['ma', 'ka', "moku'āina", "'o", "hawai'i"],
    },
  ],
  equivalent: [
    ['ʻōlelo', 'ʼōlelo'],
    ['Hawaiʻi', "Hawai'i"],
  ],
  retrievable: [
    {
      query: 'makuahine',
      text: 'ʻO ka ʻōlelo Hawaiʻi — ua mea ʻōlelo makuahine a ka poʻe maoli o ka pae moku ʻo Hawaiʻi, ma laila wale nō kahi e ʻōlelo ʻia nei ia ʻōlelo, no ka mea, ʻaʻole nui ka poʻe ʻōlelo Hawaiʻi i kēia mau lā.',
    },
    {
      query: 'kūhelu',
      text: 'He ʻōlelo kūhelu ka ʻōlelo Hawaiʻi me ka ʻōlelo Pelekania ma ka mokuʻāina ʻo Hawaiʻi wale nō.',
    },
  ],
})
