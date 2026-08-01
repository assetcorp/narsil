import { kinyarwanda } from '../../../languages/kinyarwanda'
import { defineLanguageFixture } from './types'

const RW_LANGUAGE = "Kinyarwanda Wikipedia, article 'Ikinyarwanda' (https://rw.wikipedia.org/wiki/Ikinyarwanda)"

export const kinyarwandaFixture = defineLanguageFixture({
  module: kinyarwanda,
  samples: [
    {
      text: "Ikinyarwanda ni ururimi gakondo rw'u Rwanda.",
      source: RW_LANGUAGE,
    },
    {
      text: 'Ikinyarwanda gisa n’Ikirundi, ururimi rw’i Burundi, kikanasa n’Igiha cyo muri Tanzaniya.',
      source: RW_LANGUAGE,
    },
  ],
  indivisible: ['ikinyarwanda', 'gakondo', 'ururimi', 'tanzaniya'],
  separates: [
    {
      text: "rw'u Rwanda",
      tokens: ['rw', 'u', 'rwanda'],
    },
    {
      text: 'ururimi rw’i Burundi',
      tokens: ['ururimi', 'rw', 'i', 'burundi'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'gakondo',
      text: "Ikinyarwanda ni ururimi gakondo rw'u Rwanda.",
    },
    {
      query: 'burundi',
      text: 'Ikinyarwanda gisa n’Ikirundi, ururimi rw’i Burundi, kikanasa n’Igiha cyo muri Tanzaniya.',
    },
  ],
})
