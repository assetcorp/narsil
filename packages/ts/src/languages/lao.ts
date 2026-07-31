/*
 * Stop words sourced from:
 *   - LaoNLP stopwords_lao.txt (https://github.com/wannaphong/LaoNLP), Apache-2.0,
 *     translated by that project from the Lucene th list of Sukhum, Nitsuwat, and
 *     Haruechaiyasak
 *   - ຫຼື added for Narsil: Lao Wikipedia writes it 18 times against 4 for the
 *     U+0EBC-free form the source lists
 *   - Only entries a bigram tokenizer can match are kept, because a token of this
 *     language is two characters wide
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'ກໍ',
  'ກັນ',
  'ກັບ',
  'ຂໍ',
  'ຂຶ້ນ',
  'ຄັ້ງ',
  'ຄື',
  'ຄົງ',
  'ຈະ',
  'ຈັດ',
  'ຈຶ່ງ',
  'ສິ່ງ',
  'ສຸດ',
  'ສົ່ງ',
  'ຍັງ',
  'ດັງ',
  'ໄດ້',
  'ຕໍ່',
  'ຕັ້ງ',
  'ແຕ່',
  'ຖ້າ',
  'ຖືກ',
  'ທັງ',
  'ທີ່',
  'ທຸກ',
  'ນັກ',
  'ນັ້ນ',
  'ນໍາ',
  'ນີ້',
  'ໃນ',
  'ບໍ່',
  'ໄປ',
  'ຜົນ',
  'ພົບ',
  'ມາ',
  'ມີ',
  'ມື້',
  'ຢູ່',
  'ລົງ',
  'ວ່າ',
  'ໄວ້',
  'ຫລື',
  'ຫຼື',
  'ໃຫ້',
  'ອີກ',
  'ຮັບ',
])

export const lao: LanguageModule = {
  name: 'lao',
  stemmer: null,
  stopWords,
  tokenizer: {
    splitPattern: /[^ກ-ໟa-z0-9]+/giu,
    normalizeDiacritics: false,
    minTokenLength: 1,
    ngramSize: 2,
  },
}
