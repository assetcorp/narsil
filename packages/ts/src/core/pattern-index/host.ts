import { requireLoadedOptionalReads } from '../../engine/optional-reads-code'
import { requirePatternSearch } from './registry'
import type { PatternHost, PatternIndexWriter } from './types'

export function patternHost(): PatternHost {
  const { appendFoldedCodePoint, singleFoldTable } = requireLoadedOptionalReads()
  return { appendFoldedCodePoint, singleFolds: singleFoldTable }
}

export function patternIndexOf(indexes: Map<string, PatternIndexWriter>, fieldPath: string): PatternIndexWriter {
  let index = indexes.get(fieldPath)
  if (index === undefined) {
    index = requirePatternSearch(fieldPath).createIndex(patternHost())
    indexes.set(fieldPath, index)
  }
  return index
}
