import { arabic } from '../../../languages/arabic'
import { defineLanguageFixture } from './types'

const AR_WIKIPEDIA = "Arabic Wikipedia, article 'اللغة العربية' (https://ar.wikipedia.org/wiki/اللغة_العربية)"
const AR_WIKISOURCE =
  'Arabic Wikisource, Quran 1:1-2, Hafs reading (https://ar.wikisource.org/wiki/القرآن_الكريم_(بالرسم_الإملائي)/سورة_الفاتحة)'

export const arabicFixture = defineLanguageFixture({
  module: arabic,
  samples: [
    {
      text: 'العربية لغةٌ رسمية في كل دول الوطن العربي إضافة إلى كونها لغة رسمية في تشاد وإريتريا.',
      source: AR_WIKIPEDIA,
    },
    {
      text: 'بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ',
      source: AR_WIKISOURCE,
    },
    {
      text: 'الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ',
      source: AR_WIKISOURCE,
    },
  ],
  indivisible: ['العربية', 'لغةٌ', 'بِسْمِ', 'الرَّحْمَنِ', 'الْحَمْدُ', 'رَبِّ'],
  separates: [
    { text: 'العربية لغةٌ رسمية', tokens: ['العربية', 'لغةٌ', 'رسمية'] },
    { text: 'بِسْمِ اللَّهِ الرَّحْمَنِ', tokens: ['بِسْمِ', 'اللَّهِ', 'الرَّحْمَنِ'] },
  ],
  equivalent: [],
  retrievable: [
    { query: 'الرحمن', text: 'بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ' },
    {
      query: 'العربية',
      text: 'العربية لغةٌ رسمية في كل دول الوطن العربي إضافة إلى كونها لغة رسمية في تشاد وإريتريا.',
    },
  ],
})
