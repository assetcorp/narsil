import { sorani } from '../../../languages/sorani'
import { defineLanguageFixture } from './types'

const CKB_LANGUAGE = "Sorani Kurdish Wikipedia, article 'زمانی کوردی' (https://ckb.wikipedia.org/wiki/زمانی_کوردی)"

export const soraniFixture = defineLanguageFixture({
  module: sorani,
  samples: [
    {
      text: 'زمانی کوردی زمانێکە کە نەتەوەی کورد قسەی پێ دەکەن.',
      source: CKB_LANGUAGE,
    },
    {
      text: 'لە ڕووی بنەماڵەوە بەشێکە لە زمانە ھیندوئەورووپایییەکان.',
      source: CKB_LANGUAGE,
    },
  ],
  indivisible: ['کوردی', 'زمانێکە', 'نەتەوەی', 'بنەماڵەوە'],
  separates: [
    {
      text: 'نەتەوەی کورد قسەی پێ دەکەن',
      tokens: ['نەتەوەی', 'کورد', 'قسەی', 'پێ', 'دەکەن'],
    },
    {
      text: 'لە ڕووی بنەماڵەوە',
      tokens: ['لە', 'ڕووی', 'بنەماڵەوە'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'نەتەوەی',
      text: 'زمانی کوردی زمانێکە کە نەتەوەی کورد قسەی پێ دەکەن.',
    },
    {
      query: 'بنەماڵەوە',
      text: 'لە ڕووی بنەماڵەوە بەشێکە لە زمانە ھیندوئەورووپایییەکان.',
    },
  ],
})
