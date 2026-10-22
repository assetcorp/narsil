import { appendFoldedCodePoint } from '../ordering/fold-compare'
import { singleFoldTable } from '../ordering/fold-table'
import { requirePatternSearch } from './registry'
import type { PatternHost, PatternIndexWriter } from './types'

const NO_SOURCES: readonly number[] = []

let foldSources: Map<number, number[]> | null = null

function sourcesByFold(): Map<number, number[]> {
  if (foldSources !== null) return foldSources
  const sources = new Map<number, number[]>()
  const add = (source: number, folded: number): void => {
    const known = sources.get(folded)
    if (known === undefined) sources.set(folded, [source])
    else known.push(source)
  }
  for (const [source, folded] of singleFoldTable()) add(source, folded)
  foldSources = sources
  return sources
}

function singleFoldSources(folded: number): readonly number[] {
  return sourcesByFold().get(folded) ?? NO_SOURCES
}

export const PATTERN_HOST: PatternHost = { appendFoldedCodePoint, singleFoldSources }

export function patternIndexOf(indexes: Map<string, PatternIndexWriter>, fieldPath: string): PatternIndexWriter {
  let index = indexes.get(fieldPath)
  if (index === undefined) {
    index = requirePatternSearch(fieldPath).createIndex(PATTERN_HOST)
    indexes.set(fieldPath, index)
  }
  return index
}
