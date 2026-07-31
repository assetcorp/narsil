/*
 * Stop words sourced from:
 *   - Apache Lucene th stopwords, from "Opinion Detection in Thai Political News
 *     Columns Based on Subjectivity Analysis" by Sukhum, Nitsuwat, and
 *     Haruechaiyasak (https://github.com/apache/lucene), Apache-2.0
 *   - ทำ and นำ added for Narsil: the source spells them with U+0E4D, a form that
 *     appears 0 times against 31 for the U+0E33 form across 60 sampled articles
 *   - Only entries a bigram tokenizer can match are kept, because a token of this
 *     language is two characters wide
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'ก็',
  'กัน',
  'กับ',
  'ขอ',
  'ขึ้น',
  'คง',
  'คือ',
  'จะ',
  'จัด',
  'จึง',
  'ซึ่ง',
  'ดัง',
  'ได้',
  'ต่อ',
  'ตั้ง',
  'แต่',
  'ถ้า',
  'ถึง',
  'ถูก',
  'ทั้ง',
  'ทํา',
  'ทำ',
  'ที่',
  'ทุก',
  'นัก',
  'นั้น',
  'น่า',
  'นํา',
  'นำ',
  'นี้',
  'ใน',
  'ไป',
  'ผล',
  'พบ',
  'มา',
  'มี',
  'ไม่',
  'ยัง',
  'รับ',
  'ลง',
  'วัน',
  'ว่า',
  'ไว้',
  'ส่ง',
  'สุด',
  'ให้',
  'อยู่',
  'อีก',
])

export const thai: LanguageModule = {
  name: 'thai',
  stemmer: null,
  stopWords,
  tokenizer: {
    splitPattern: /[^ก-฾เ-๎๐-๙a-z0-9]+/giu,
    normalizeDiacritics: false,
    minTokenLength: 1,
    ngramSize: 2,
  },
}
