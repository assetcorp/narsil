import { urdu } from '../../../languages/urdu'
import { defineLanguageFixture } from './types'

const UR_LANGUAGE = "Urdu Wikipedia, article 'اردو' (https://ur.wikipedia.org/wiki/اردو)"

export const urduFixture = defineLanguageFixture({
  module: urdu,
  samples: [
    {
      text: 'اُردُو، برصغیر پاک و ہند کی معیاری زبانوں میں سے ایک ہے۔',
      source: UR_LANGUAGE,
    },
    {
      text: 'یہ پاکستان کی قومی اور رابطہ عامہ کی زبان ہے، جبکہ بھارت کی چھ ریاستوں کی دفتری زبان کا درجہ رکھتی ہے۔',
      source: UR_LANGUAGE,
    },
  ],
  indivisible: ['پاکستان', 'زبانوں', 'دفتری', 'ریاستوں', 'برصغیر'],
  separates: [
    {
      text: 'پاکستان کی قومی اور رابطہ عامہ کی زبان',
      tokens: ['پاکستان', 'کی', 'قومی', 'اور', 'رابطہ', 'عامہ', 'کی', 'زبان'],
    },
    {
      text: 'بھارت کی چھ ریاستوں',
      tokens: ['بھارت', 'کی', 'چھ', 'ریاستوں'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'برصغیر',
      text: 'اُردُو، برصغیر پاک و ہند کی معیاری زبانوں میں سے ایک ہے۔',
    },
    {
      query: 'ریاستوں',
      text: 'یہ پاکستان کی قومی اور رابطہ عامہ کی زبان ہے، جبکہ بھارت کی چھ ریاستوں کی دفتری زبان کا درجہ رکھتی ہے۔',
    },
  ],
})
