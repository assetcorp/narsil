import { greek } from '../../../languages/greek'
import { defineLanguageFixture } from './types'

const EL_LANGUAGE = "Greek Wikipedia, article 'Ελληνική γλώσσα' (https://el.wikipedia.org/wiki/Ελληνική_γλώσσα)"
const EL_ILIAD = 'Greek Wikisource, Homer, Iliad, Book A (https://el.wikisource.org/wiki/Ιλιάς/Α)'

export const greekFixture = defineLanguageFixture({
  module: greek,
  samples: [
    {
      text: 'Η ελληνική γλώσσα ανήκει στην ινδοευρωπαϊκή οικογένεια και αποτελεί το μοναδικό μέλος του ελληνικού κλάδου.',
      source: EL_LANGUAGE,
    },
    {
      text: 'Ανήκει επίσης στο βαλκανικό γλωσσικό δεσμό.',
      source: EL_LANGUAGE,
    },
    {
      text: 'Μῆνιν ἄειδε, θεά, Πηληϊάδεω Ἀχιλῆος οὐλομένην',
      source: EL_ILIAD,
    },
  ],
  indivisible: ['ελληνική', 'γλώσσα', 'ινδοευρωπαϊκή', 'μῆνιν', 'ἄειδε', 'ἀχιλῆος', 'οὐλομένην', 'ο', 'η'],
  separates: [
    { text: 'Η ελληνική γλώσσα', tokens: ['η', 'ελληνική', 'γλώσσα'] },
    { text: 'Μῆνιν ἄειδε, θεά', tokens: ['μῆνιν', 'ἄειδε', 'θεά'] },
    {
      text: 'Ανήκει επίσης στο βαλκανικό γλωσσικό δεσμό.',
      tokens: ['ανήκει', 'επίσης', 'στο', 'βαλκανικό', 'γλωσσικό', 'δεσμό'],
    },
  ],
  equivalent: [
    ['Ελληνική', 'ελληνική'],
    ['ἄειδε', 'άειδε'],
  ],
  retrievable: [
    {
      query: 'ελληνική',
      text: 'Η ελληνική γλώσσα ανήκει στην ινδοευρωπαϊκή οικογένεια και αποτελεί το μοναδικό μέλος του ελληνικού κλάδου.',
    },
    { query: 'ἄειδε', text: 'Μῆνιν ἄειδε, θεά, Πηληϊάδεω Ἀχιλῆος οὐλομένην' },
  ],
})
