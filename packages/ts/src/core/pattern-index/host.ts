import { appendFoldedCodePoint } from '../ordering/fold-compare'
import { singleFoldTable } from '../ordering/fold-table'
import { requirePatternSearch } from './registry'
import type { PatternHost, PatternIndexWriter } from './types'

export const PATTERN_HOST: PatternHost = { appendFoldedCodePoint, singleFolds: singleFoldTable }

export function patternIndexOf(indexes: Map<string, PatternIndexWriter>, fieldPath: string): PatternIndexWriter {
  let index = indexes.get(fieldPath)
  if (index === undefined) {
    index = requirePatternSearch(fieldPath).createIndex(PATTERN_HOST)
    indexes.set(fieldPath, index)
  }
  return index
}
