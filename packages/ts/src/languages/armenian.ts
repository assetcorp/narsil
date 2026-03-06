import type { LanguageModule } from '../types/language'

const VOWELS = '\u0561\u0565\u0567\u056b\u0578\u0585'

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch)
}

function findR2(word: string): number {
  let r2 = word.length
  let vcvcCount = 0
  let sawVowel = false

  for (let i = 0; i < word.length; i++) {
    const v = isVowel(word[i])
    if (v && !sawVowel) {
      sawVowel = true
    } else if (!v && sawVowel) {
      vcvcCount++
      sawVowel = false
      if (vcvcCount === 2) {
        r2 = i + 1
        break
      }
    }
  }

  return r2
}

function removeSuffixInRegion(word: string, suffixes: string[], regionStart: number): string | null {
  for (const suffix of suffixes) {
    if (word.endsWith(suffix) && word.length - suffix.length >= regionStart) {
      return word.slice(0, word.length - suffix.length)
    }
  }
  return null
}

const ENDING_SUFFIXES = [
  '\u0565\u0580\u0578\u0580\u0564',
  '\u0580\u0578\u0580\u0564',
  '\u0578\u0580\u0561\u056f',
  '\u0561\u056f\u0561\u0576',
  '\u0561\u0580\u0561\u0576',
  '\u0565\u056f\u0565\u0576',
  '\u0565\u0580\u0565\u0576',
  '\u0578\u0580\u0567\u0576',
  '\u0578\u057e\u056b\u0576',
  '\u056c\u0561\u0575\u0576',
  '\u057e\u0578\u0582\u0576',
  '\u0561\u057e\u0565\u057f',
  '\u0563\u056b\u0576',
  '\u0561\u056c\u056b',
  '\u0561\u056f\u056b',
  '\u057a\u0565\u057d',
  '\u056f\u0578\u057f',
  '\u0562\u0561\u0580',
  '\u0565\u0572',
  '\u0565\u0576',
  '\u056b\u0576',
  '\u056b\u057e',
  '\u0561\u057f',
]

const VERB_SUFFIXES = [
  '\u0561\u0581\u0580\u056b\u0576\u0584',
  '\u057e\u0565\u0581\u056b\u0576\u0584',
  '\u0565\u0581\u056b\u0576\u0584',
  '\u0561\u0581\u056b\u0576\u0584',
  '\u0561\u0581\u0561\u0576\u0584',
  '\u0561\u0581\u0580\u056b\u0584',
  '\u057e\u0565\u0581\u056b\u0584',
  '\u0565\u0581\u0576\u0565\u056c',
  '\u0561\u0581\u057e\u0565\u056c',
  '\u0565\u0581\u057e\u0565\u056c',
  '\u0561\u0581\u0576\u0561\u056c',
  '\u0561\u0581\u0561\u0584',
  '\u0565\u0581\u056b\u0584',
  '\u0561\u0581\u056b\u0584',
  '\u057e\u0565\u0581\u056b\u0580',
  '\u0561\u0581\u0580\u056b\u0580',
  '\u0565\u0581\u056b\u0580',
  '\u0561\u0581\u056b\u0580',
  '\u0561\u0581\u0580\u0565\u0581',
  '\u0565\u056c\u0578\u0582\u0581',
  '\u0561\u056c\u0578\u0582\u0581',
  '\u057e\u0565\u0581\u056b',
  '\u0565\u0581\u056b',
  '\u0561\u0581\u056b',
  '\u0561\u0581\u0580\u056b',
  '\u0561\u056c\u056b\u057d',
  '\u0565\u056c\u056b\u057d',
  '\u0561\u0581\u0561\u0580',
  '\u0565\u0581\u0561\u0580',
  '\u0561\u0581\u0561\u057e',
  '\u0565\u0581\u0561\u057e',
  '\u0561\u0581\u0561\u0576',
  '\u0561\u0581\u0561',
  '\u0565\u0581\u0561',
  '\u057e\u0578\u0582\u0574',
  '\u0578\u0582\u0574',
  '\u0561\u056c\u0578\u057e',
  '\u0565\u056c\u0578\u057e',
  '\u0561\u056c\u0578\u0582',
  '\u0565\u056c\u0578\u0582',
  '\u0568\u0561\u056c',
  '\u0561\u0576\u0561\u056c',
  '\u0565\u0576\u0561\u056c',
  '\u0581\u0576\u0565\u056c',
  '\u0579\u0565\u056c',
  '\u057e\u0565\u056c',
  '\u057f\u0565\u056c',
  '\u0561\u057f\u0565\u056c',
  '\u0578\u057f\u0565\u056c',
  '\u056f\u0578\u057f\u0565\u056c',
  '\u0568\u0565\u056c',
  '\u0576\u0565\u056c',
  '\u057e\u0561\u056e',
  '\u0561\u056c',
  '\u0565\u056c',
  '\u0561\u0576',
  '\u0581\u0561\u0576',
  '\u0561\u0576\u0584',
  '\u0581\u0561\u0576\u0584',
  '\u0561\u057e',
  '\u0561\u0580',
  '\u0561\u0581',
  '\u0565\u0581',
  '\u0561\u0584',
  '\u0581\u0561\u0584',
  '\u057e\u0565',
  '\u0561',
]

const ADJECTIVE_SUFFIXES = [
  '\u0578\u0582\u0569\u0575\u0578\u0582\u0576',
  '\u0578\u0582\u0569\u0575\u0578\u0582\u0576',
  '\u0561\u0576\u0585\u0581',
  '\u057e\u0561\u056e\u0584',
  '\u0578\u0582\u0575\u0584',
  '\u057d\u057f\u0561\u0576',
  '\u0561\u0580\u0561\u0576',
  '\u0565\u0572\u0567\u0576',
  '\u0575\u0578\u0582\u0576',
  '\u0561\u0576\u0561\u056f',
  '\u0575\u0561\u056f',
  '\u0578\u0582\u0570\u056b',
  '\u0578\u0582\u0575\u0569',
  '\u0574\u0578\u0582\u0576\u0584',
  '\u0578\u0582\u0576\u0584',
  '\u0561\u056c\u056b\u0584',
  '\u0561\u0576\u056b\u0584',
  '\u0579\u0565\u0584',
  '\u0578\u0576\u0584',
  '\u0565\u0576\u0584',
  '\u0561\u0580\u0584',
  '\u056b\u0579\u0584',
  '\u0578\u0582\u057d\u057f',
  '\u0578\u0582\u057d',
  '\u0578\u0582\u056f',
  '\u0561\u056e\u0578',
  '\u057a\u0561\u0576',
  '\u0563\u0561\u0580',
  '\u057e\u0578\u0580',
  '\u0561\u057e\u0578\u0580',
  '\u0581\u056b',
  '\u056b\u056c',
  '\u056b\u056f',
  '\u0561\u056f',
  '\u0561\u0576',
  '\u0578\u0580\u0564',
  '\u0578\u0581',
  '\u0578\u0582',
  '\u056b\u0579',
  '\u056b\u0584',
  '\u0584',
]

const NOUN_SUFFIXES = [
  '\u0578\u0582\u0569\u0575\u0561\u0576\u0564',
  '\u0578\u0582\u0569\u0575\u0561\u0576\u0576',
  '\u0578\u0582\u0569\u0575\u0561\u0576\u057d',
  '\u0578\u0582\u0569\u0575\u0561\u0576\u0568',
  '\u0578\u0582\u0569\u0575\u0561\u0576',
  '\u0576\u0565\u0580\u0578\u0582\u0574',
  '\u0561\u0576\u0578\u0582\u0574',
  '\u0565\u0580\u0578\u0582\u0574',
  '\u057e\u0561\u0576\u056b\u0581',
  '\u057e\u0561\u0576\u0564',
  '\u057e\u0561\u0576\u0568',
  '\u057e\u0561\u0576',
  '\u057e\u0561\u0576\u057d',
  '\u0576\u0565\u0580\u0564',
  '\u0576\u0565\u0580\u0568',
  '\u0576\u0565\u0580\u056b\u0576',
  '\u0576\u0565\u0580\u056b',
  '\u0576\u0565\u0580\u0576',
  '\u0576\u0565\u0580\u0578\u057e',
  '\u0576\u0565\u0580\u056b\u0581',
  '\u0576\u0565\u0580',
  '\u0561\u0576\u0578\u057e',
  '\u057e\u0578\u057e',
  '\u0565\u0580\u0578\u057e',
  '\u0565\u0580\u056b\u0581',
  '\u0578\u057b\u056b\u0581',
  '\u057e\u056b\u0581',
  '\u0581\u056b\u0581',
  '\u0565\u0580\u056b',
  '\u0565\u0580\u0564',
  '\u0565\u0580\u0568',
  '\u0565\u0580\u0576',
  '\u0578\u057b\u0564',
  '\u0578\u057b\u0568',
  '\u0578\u057b\u057d',
  '\u0578\u0582\u0564',
  '\u0561\u0576\u0564',
  '\u0561\u0576\u0568',
  '\u056b\u0576',
  '\u0578\u0582\u0576',
  '\u0578\u057b',
  '\u0578\u057e',
  '\u0565\u0580',
  '\u056b\u0581',
  '\u0578\u0581',
  '\u0578\u0582\u0581',
  '\u057d\u0561',
  '\u057e\u0561',
  '\u0561\u0574\u0562',
  '\u0576',
  '\u0561\u0576',
  '\u0564',
  '\u0568',
  '\u057e\u056b',
  '\u056b',
  '\u057d',
  '\u0581',
]

function stem(word: string): string {
  if (word.length < 3) return word

  const r2 = findR2(word)

  if (word.length <= r2) return word

  const nounResult = removeSuffixInRegion(word, NOUN_SUFFIXES, r2)
  if (nounResult !== null) {
    word = nounResult
  } else {
    const verbResult = removeSuffixInRegion(word, VERB_SUFFIXES, r2)
    if (verbResult !== null) {
      word = verbResult
    } else {
      const adjResult = removeSuffixInRegion(word, ADJECTIVE_SUFFIXES, r2)
      if (adjResult !== null) {
        word = adjResult
      }
    }
  }

  const endingResult = removeSuffixInRegion(word, ENDING_SUFFIXES, r2)
  if (endingResult !== null) {
    word = endingResult
  }

  return word
}

const stopWords = new Set([
  '\u0561\u0575\u0564',
  '\u0561\u0575\u056c',
  '\u0561\u0575\u0576',
  '\u0561\u0575\u057d',
  '\u0564\u0578\u0582',
  '\u0564\u0578\u0582\u0584',
  '\u0565\u0574',
  '\u0565\u0576',
  '\u0565\u0576\u0584',
  '\u0565\u057d',
  '\u0565\u0584',
  '\u0567',
  '\u0567\u056b',
  '\u0567\u056b\u0576',
  '\u0567\u056b\u0576\u0584',
  '\u0567\u056b\u0580',
  '\u0567\u056b\u0584',
  '\u0567\u0580',
  '\u0568\u057d\u057f',
  '\u0569',
  '\u056b',
  '\u056b\u0576',
  '\u056b\u057d\u056f',
  '\u056b\u0580',
  '\u056f\u0561\u0574',
  '\u0570\u0561\u0574\u0561\u0580',
  '\u0570\u0565\u057f',
  '\u0570\u0565\u057f\u0578',
  '\u0574\u0565\u0576\u0584',
  '\u0574\u0565\u057b',
  '\u0574\u056b',
  '\u0576',
  '\u0576\u0561',
  '\u0576\u0561\u0587',
  '\u0576\u0580\u0561',
  '\u0576\u0580\u0561\u0576\u0584',
  '\u0578\u0580',
  '\u0578\u0580\u0568',
  '\u0578\u0580\u0578\u0576\u0584',
  '\u0578\u0580\u057a\u0565\u057d',
  '\u0578\u0582',
  '\u0578\u0582\u0574',
  '\u057a\u056b\u057f\u056b',
  '\u057e\u0580\u0561',
  '\u0587',
])

export const armenian: LanguageModule = {
  name: 'armenian',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^\u0531-\u0587a-z0-9]+/gi },
}
