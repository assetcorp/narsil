/*
 * Stop words sourced from:
 *   - stopwords-iso/stopwords-yo (https://github.com/stopwords-iso/stopwords-yo), MIT
 *   - Diacritized function words curated for Narsil
 *
 * Diacritics (tone marks and subdots) are preserved as they are phonemically distinct in Yoruba.
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'ó',
  'ní',
  'ṣe',
  'rẹ̀',
  'tí',
  'àwọn',
  'sì',
  'sí',
  'ni',
  'náà',
  'láti',
  'kan',
  'ti',
  'ń',
  'lọ',
  'o',
  'bí',
  'padà',
  'wà',
  'wá',
  'kí',
  'púpọ̀',
  'mi',
  'wọ́n',
  'pẹ̀lú',
  'a',
  'ṣùgbọ́n',
  'fún',
  'jẹ́',
  'fẹ́',
  'kò',
  'jù',
  'pé',
  'é',
  'gbogbo',
  'inú',
  'bẹ̀rẹ̀',
  'jẹ',
  'ọjọ́',
  'nítorí',
  'nǹkan',
  'sínú',
  'ṣ',
  'yìí',
  'ṣé',
  'àti',
  'í',
  'máa',
  'nígbà',
  'mo',
  'an',
  'mọ̀',
  'bá',
  'kì',
  'ńlá',
  'ọ̀pọ̀lọpọ̀',
  'ẹmọ́',
  'wọn',
  'òun',
  'lè',
  'tabi',
  'lórí',
  'nínú',
  'lábẹ́',
  'lókè',
  'lẹ́yìn',
  'níwájú',
  'láàárín',
  'nípa',
  'gẹ́gẹ́',
  'irú',
  'bẹ́ẹ̀',
  'ohun',
  'ẹni',
  'ẹ',
  'kọ́',
  'wọ̀nyí',
  'ìwọ',
  'èmi',
  'àwa',
  'ẹyin',
  'ọ̀un',
  'tàbí',
  'nítorípé',
  'díẹ̀',
  'nìkan',
  'pàápàá',
  'síbẹ̀',
])

/**
 * Yoruba analysis: the stop word list and the rules that split Yoruba
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `yoruba`.
 *
 * @public
 */
export const yoruba: LanguageModule = {
  name: 'yoruba',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: {
    splitPattern: /[^a-zA-ZàáèéìíòóùúẹọṣńǹÀÁÈÉÌÍÒÓÙÚẸỌṢŃǸ0-9\p{M}]+/giu,
    normalizeDiacritics: false,
    minTokenLength: 1,
  },
}
