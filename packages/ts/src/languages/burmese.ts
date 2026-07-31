/*
 * Stop words sourced from:
 *   - stopword mya list by Kyaw-Zin-Thant
 *     (https://github.com/fergiemcdowall/stopword), MIT
 *   - ၎င်း added for Narsil: Burmese Wikipedia writes it 4 times against 0 for the
 *     digit-four form the source lists
 *   - Only entries a bigram tokenizer can match are kept, because a token of this
 *     language is two characters wide
 */

import type { LanguageModule } from '../types/language'

const stopWords = new Set([
  '၍',
  '၎င်း',
  '၄င်း',
  'ကျနော်',
  'ကျမ',
  'ကျုပ်',
  'ကဲ့သို့',
  'ငါ',
  'ငါကို',
  'ငါတို့',
  'တဲ့',
  'ထို',
  'ထိုဟာ',
  'ဒါ',
  'ဒီဟာ',
  'နှင့်',
  'ပါက',
  'ပေမဲ့',
  'ဘာလဲ',
  'မင်း',
  'မည့်',
  'လျှင်',
  'လုံးလုံး',
  'သင်',
  'သည့်',
  'သူ',
  'သူ၏',
  'သူ့ကို',
  'သူတို့',
  'သူမ',
  'သူဟာ',
  'သူ့ဟာ',
  'ဟိုဟာ',
  'ဟောဒါ',
  'ဟောဒီ',
  'အချို့',
  'အပေါ်',
  'အားလုံး',
  'အဲဒါ',
  'ဤမျှ',
])

export const burmese: LanguageModule = {
  name: 'burmese',
  stemmer: null,
  stopWords,
  tokenizer: {
    splitPattern: /[^က-၉၌-႟a-z0-9]+/giu,
    normalizeDiacritics: false,
    minTokenLength: 1,
    ngramSize: 2,
  },
}
