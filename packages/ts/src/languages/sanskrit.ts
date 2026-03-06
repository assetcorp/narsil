import type { LanguageModule } from '../types/language'

const LONG_NOMINAL_ENDINGS = [
  '\u0906\u0928\u093E\u092E\u094D',
  '\u090F\u092D\u094D\u092F\u0903',
  '\u093E\u0923\u093E\u092E\u094D',
  '\u0947\u092D\u094D\u092F\u0903',
  '\u0906\u092D\u094D\u092F\u093E\u092E\u094D',
  '\u093E\u092D\u094D\u092F\u093E\u092E\u094D',
]

const MEDIUM_NOMINAL_ENDINGS = [
  '\u0938\u094D\u092F',
  '\u0947\u0928',
  '\u0947\u0937\u0941',
  '\u093E\u0924\u094D',
  '\u093E\u092E\u094D',
  '\u092F\u093E',
  '\u094C',
  '\u093E\u0903',
  '\u093E\u0928\u094D',
  '\u0905\u0903',
  '\u0903',
  '\u092E\u094D',
  '\u093E\u092E',
  '\u0906',
]

const SHORT_NOMINAL_ENDINGS = ['\u093E', '\u093F', '\u0940', '\u0941', '\u0942', '\u0947', '\u094B', '\u0902']

const VERB_ENDINGS = [
  '\u0928\u094D\u0924\u093F',
  '\u0928\u094D\u0924\u0947',
  '\u0938\u093F',
  '\u0924\u093F',
  '\u092E\u093F',
  '\u0924\u0947',
  '\u0938\u0947',
  '\u0905\u092E\u094D',
  '\u0924\u0941',
  '\u0928\u094D\u0924\u0941',
]

function charLen(str: string): number {
  let count = 0
  for (const _ of str) {
    count++
  }
  return count
}

function endsWithStr(word: string, suffix: string): boolean {
  return word.endsWith(suffix)
}

function removeSuffix(word: string, suffix: string): string {
  return word.slice(0, word.length - suffix.length)
}

function tryRemoveFromList(word: string, suffixes: string[], minRemaining: number): string {
  for (const suffix of suffixes) {
    if (endsWithStr(word, suffix)) {
      const stem = removeSuffix(word, suffix)
      if (charLen(stem) >= minRemaining) {
        return stem
      }
    }
  }
  return word
}

function stem(word: string): string {
  if (charLen(word) < 4) return word

  let result = tryRemoveFromList(word, LONG_NOMINAL_ENDINGS, 3)
  if (result !== word) return result

  result = tryRemoveFromList(word, MEDIUM_NOMINAL_ENDINGS, 3)
  if (result !== word) return result

  result = tryRemoveFromList(word, VERB_ENDINGS, 3)
  if (result !== word) return result

  result = tryRemoveFromList(word, SHORT_NOMINAL_ENDINGS, 3)
  return result
}

const stopWords = new Set([
  '\u091A',
  '\u0935\u093E',
  '\u0928',
  '\u0905\u092A\u093F',
  '\u0924\u0941',
  '\u090F\u0935',
  '\u0939',
  '\u0907\u0924\u093F',
  '\u0924\u0924\u094D',
  '\u092F\u0924\u094D',
  '\u0915\u093F\u092E\u094D',
  '\u0905\u0925',
  '\u0905\u0924\u094D\u0930',
  '\u0924\u0925\u093E',
  '\u0907\u0926\u092E\u094D',
  '\u090F\u0924\u0924\u094D',
  '\u0938\u0903',
  '\u0938\u093E',
  '\u0905\u092F\u092E\u094D',
  '\u0907\u092F\u092E\u094D',
  '\u0905\u0938\u094D\u0924\u093F',
  '\u092D\u0935\u0924\u093F',
  '\u092F\u0926\u093F',
  '\u0924\u0930\u094D\u0939\u093F',
  '\u0905\u0925\u0935\u093E',
  '\u092A\u0930\u0928\u094D\u0924\u0941',
  '\u0915\u0926\u093E',
  '\u0915\u0941\u0924\u094D\u0930',
  '\u0915\u0925\u092E\u094D',
  '\u0938\u0939',
  '\u0935\u093F\u0928\u093E',
  '\u092A\u094D\u0930\u0924\u093F',
  '\u0905\u0928\u0941',
  '\u0905\u0927\u093F',
  '\u0905\u092D\u093F',
  '\u0909\u092A',
  '\u092A\u0930\u093F',
  '\u0905\u0935',
  '\u0928\u093F\u0903',
  '\u0906',
  '\u0909\u0924',
  '\u0905\u092A\u0930\u092E\u094D',
  '\u092A\u0941\u0928\u0903',
  '\u092F\u0925\u093E',
  '\u090F\u0935\u092E\u094D',
  '\u0907\u0935',
  '\u0928\u093E\u092E',
  '\u0916\u0932\u0941',
  '\u0939\u093F',
  '\u0928\u0941',
  '\u0905\u0924\u0903',
  '\u0924\u0924\u0903',
  '\u092F\u0924\u0903',
  '\u0915\u0941\u0924\u0903',
  '\u0905\u0924 \u090F\u0935',
  '\u0924\u0924\u094D\u0930',
  '\u092F\u0924\u094D\u0930',
  '\u0938\u0930\u094D\u0935\u0924\u094D\u0930',
  '\u0905\u0928\u094D\u092F\u0924\u094D\u0930',
  '\u0907\u0924\u0903',
  '\u092E\u092E',
  '\u0924\u0935',
  '\u0905\u0938\u094D\u092F',
  '\u0905\u0938\u094D\u092F\u093E\u0903',
  '\u0924\u0938\u094D\u092F',
  '\u0924\u0938\u094D\u092F\u093E\u0903',
  '\u090F\u0937\u0903',
  '\u090F\u0937\u093E',
  '\u0938\u0930\u094D\u0935\u092E\u094D',
  '\u0915\u093F\u091E\u094D\u091A\u093F\u0924\u094D',
  '\u0905\u0928\u094D\u092F\u0924\u094D',
])

export const sanskrit: LanguageModule = {
  name: 'sanskrit',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^\u0900-\u097fa-z0-9]+/gi },
}
