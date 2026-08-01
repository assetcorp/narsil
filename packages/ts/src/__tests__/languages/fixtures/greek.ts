import { greek } from '../../../languages/greek'
import { defineLanguageFixture } from './types'

const EL_LANGUAGE = "Greek Wikipedia, article 'Ελληνική γλώσσα' (https://el.wikipedia.org/wiki/Ελληνική_γλώσσα)"
const EL_ILIAD = 'Greek Wikisource, Homer, Iliad, Book A (https://el.wikisource.org/wiki/Ιλιάς/Α)'
const EL_JOHN =
  'Gospel of John 1:1, Scrivener 1894 Greek New Testament via Greek Wikisource (https://el.wikisource.org/wiki/Κατά_Ιωάννην)'

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
    {
      text: 'Ἐν ἀρχῇ ἦν ὁ λόγος, καὶ ὁ λόγος ἦν πρὸς τὸν Θεόν, καὶ Θεὸς ἦν ὁ λόγος.',
      source: EL_JOHN,
    },
  ],
  indivisible: ['ελληνική', 'γλώσσα', 'ινδοευρωπαϊκή', 'μῆνιν', 'ἄειδε', 'ἀχιλῆος', 'οὐλομένην', 'ο', 'η'],
  separates: [
    { text: 'Η ελληνική γλώσσα', tokens: ['η', 'ελληνικη', 'γλωσσα'] },
    { text: 'η ινδοευρωπαϊκή οικογένεια', tokens: ['η', 'ινδοευρωπαϊκη', 'οικογενεια'] },
    { text: 'Μῆνιν ἄειδε, θεά', tokens: ['μηνιν', 'αειδε', 'θεα'] },
    {
      text: 'Ανήκει επίσης στο βαλκανικό γλωσσικό δεσμό.',
      tokens: ['ανηκει', 'επισης', 'στο', 'βαλκανικο', 'γλωσσικο', 'δεσμο'],
    },
  ],
  equivalent: [
    ['Ελληνική', 'ελληνική'],
    ['ἄειδε', 'άειδε'],
    ['ἀρχῇ', 'αρχη'],
    ['Θεὸς', 'θεος'],
  ],
  retrievable: [
    {
      query: 'ελληνική',
      text: 'Η ελληνική γλώσσα ανήκει στην ινδοευρωπαϊκή οικογένεια και αποτελεί το μοναδικό μέλος του ελληνικού κλάδου.',
    },
    { query: 'ἄειδε', text: 'Μῆνιν ἄειδε, θεά, Πηληϊάδεω Ἀχιλῆος οὐλομένην' },
    {
      query: 'ἀρχῇ',
      text: 'Ἐν ἀρχῇ ἦν ὁ λόγος, καὶ ὁ λόγος ἦν πρὸς τὸν Θεόν, καὶ Θεὸς ἦν ὁ λόγος.',
    },
  ],
})
