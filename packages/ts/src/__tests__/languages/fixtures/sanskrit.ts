import { sanskrit } from '../../../languages/sanskrit'
import { defineLanguageFixture } from './types'

const SA_WIKIPEDIA = "Sanskrit Wikipedia, article 'संस्कृतम्' (https://sa.wikipedia.org/wiki/संस्कृतम्)"
const SA_GITA =
  'Sanskrit Wikisource, Bhagavad Gita, chapter 2 verse 1 (https://sa.wikisource.org/wiki/भगवद्गीता/साङ्ख्ययोगः)'
const EN_SANSKRIT = "English Wikipedia, article 'Sanskrit' (https://en.wikipedia.org/wiki/Sanskrit)"

export const sanskritFixture = defineLanguageFixture({
  module: sanskrit,
  samples: [
    {
      text: 'संस्कृतं भारतस्य जगतो वा भाषास्वेकतमातिप्राचीनम्।',
      source: SA_WIKIPEDIA,
    },
    {
      text: 'तं तथा कृपयाविष्टमश्रुपूर्णाकुलेक्षणम् । विषीदन्तमिदं वाक्यमुवाच मधुसूदनः ॥',
      source: SA_GITA,
    },
    {
      text: 'Sanskrit is a classical language belonging to the Indo-Aryan branch of the Indo-European languages.',
      source: EN_SANSKRIT,
    },
  ],
  indivisible: ['संस्कृतम्', 'संस्कृतं', 'मधुसूदनः', 'भारतस्य', 'saṃskṛtam'],
  separates: [
    {
      text: 'संस्कृतं भारतस्य जगतो वा भाषास्वेकतमातिप्राचीनम्।',
      tokens: ['संस्कृतं', 'भारतस्य', 'जगतो', 'वा', 'भाषास्वेकतमातिप्राचीनम्'],
    },
    { text: 'विषीदन्तमिदं वाक्यमुवाच मधुसूदनः ॥', tokens: ['विषीदन्तमिदं', 'वाक्यमुवाच', 'मधुसूदनः'] },
    { text: 'nominal singular संस्कृतम्, saṃskṛtam', tokens: ['nominal', 'singular', 'संस्कृतम्', 'saṃskṛtam'] },
  ],
  equivalent: [],
  retrievable: [
    { query: 'भारतस्य', text: 'संस्कृतं भारतस्य जगतो वा भाषास्वेकतमातिप्राचीनम्।' },
    { query: 'मधुसूदनः', text: 'तं तथा कृपयाविष्टमश्रुपूर्णाकुलेक्षणम् । विषीदन्तमिदं वाक्यमुवाच मधुसूदनः ॥' },
  ],
})
