import { appendFoldedCodePoints } from '../ordering/fold-compare'
import { requirePatternSearch } from './registry'
import type { PatternHost, PatternIndexWriter } from './types'

export const PATTERN_HOST: PatternHost = { appendFolded: appendFoldedCodePoints }

export function patternIndexOf(indexes: Map<string, PatternIndexWriter>, fieldPath: string): PatternIndexWriter {
  let index = indexes.get(fieldPath)
  if (index === undefined) {
    index = requirePatternSearch(fieldPath).createIndex(PATTERN_HOST)
    indexes.set(fieldPath, index)
  }
  return index
}
