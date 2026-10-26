import type { PartialWordHighlight } from '../../../highlighting/highlighter'
import type { LanguageModule } from '../../../types/language'
import { tokenize } from '../../tokenizer/tokenize'

function containsPartialWord(spelling: string, words: readonly string[]): boolean {
  for (const word of words) {
    if (spelling.length > word.length && spelling.includes(word)) return true
  }
  return false
}

export function partialWordMatcher(
  text: string,
  language: LanguageModule,
  partial: PartialWordHighlight,
): (position: number, fieldToken: string) => boolean {
  const indexed = tokenize(text, language, {
    stem: true,
    removeStopWords: true,
    collectSurfaces: true,
    customTokenizer: partial.customTokenizer,
    stopWordOverride: partial.stopWordOverride,
  })
  const positions = new Set<number>()
  const spellings = new Set<string>()
  for (let at = 0; at < indexed.tokens.length; at++) {
    const spelling = indexed.surfaces?.[at] ?? indexed.tokens[at].token
    if (!containsPartialWord(spelling, partial.words)) continue
    positions.add(indexed.tokens[at].position)
    spellings.add(spelling)
  }
  if (partial.customTokenizer !== undefined) return (_position, fieldToken) => spellings.has(fieldToken)
  return position => positions.has(position)
}
