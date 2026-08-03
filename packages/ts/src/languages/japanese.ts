/*
 * Stop words sourced from:
 *   - Apache Lucene kuromoji Japanese stopwords (https://github.com/apache/lucene), Apache-2.0
 *   - Additional particles, demonstratives, and compound postpositions curated for Narsil
 *   - Only entries a bigram tokenizer can produce are kept, because a token of
 *     this language is two characters of one script wide
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  'の',
  'に',
  'は',
  'を',
  'た',
  'が',
  'で',
  'て',
  'と',
  'し',
  'れ',
  'さ',
  'ある',
  'いる',
  'する',
  'なる',
  'ない',
  'も',
  'な',
  'や',
  'か',
  'へ',
  'ば',
  'よ',
  'ね',
  'まで',
  'から',
  'より',
  'ほど',
  'だけ',
  'しか',
  'まま',
  'つつ',
  'ので',
  'のに',
  'けど',
  'だが',
  'でも',
  'また',
  'なお',
  'さて',
  'では',
  'これ',
  'それ',
  'あれ',
  'どれ',
  'この',
  'その',
  'あの',
  'どの',
  'ここ',
  'そこ',
  'どこ',
  'こう',
  'そう',
  'ああ',
  'どう',
  '私',
  '僕',
  '俺',
  '自分',
  '彼',
  '彼女',
  '我々',
  '私達',
  '彼ら',
  '誰',
  '何',
  'いつ',
  'なぜ',
  'です',
  'ます',
  'べき',
  'はず',
  'わけ',
  'こと',
  'もの',
  'とき',
  'とも',
  'ため',
  'うち',
  'ほう',
  'たち',
  'ら',
  'など',
  'って',
  'もう',
  'まだ',
  'ぜひ',
  'ほぼ',
])

/**
 * Japanese analysis: the stop word list and the rules that split Japanese
 * text into tokens. Tokens are indexed as the normaliser leaves them,
 * without stemming.
 *
 * Import it and pass it to {@link registerLanguage} before you create an index
 * whose `language` is `japanese`.
 *
 * @public
 */
export const japanese: LanguageModule = {
  name: 'japanese',
  revision: '1',
  stemmer: null,
  stopWords,
  tokenizer: {
    splitPattern: /[^\p{Script=Han}\u3040-\u309f\u30a0-\u30fa\u30fc-\u30ff0-9a-zA-Z]+/giu,
    normalizeDiacritics: false,
    minTokenLength: 1,
    ngramSize: 2,
  },
}
