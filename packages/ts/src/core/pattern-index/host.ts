import { requirePatternSearch } from './registry'
import type { PatternIndexWriter } from './types'

export function patternIndexOf(indexes: Map<string, PatternIndexWriter>, fieldPath: string): PatternIndexWriter {
  let index = indexes.get(fieldPath)
  if (index === undefined) {
    const pattern = requirePatternSearch(fieldPath)
    index = pattern.createIndex(pattern.host())
    indexes.set(fieldPath, index)
  }
  return index
}
