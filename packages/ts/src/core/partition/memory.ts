import { sortColumnBytes } from './sorting'
import type { PartitionReadState } from './utils'

const AVG_DOC_OVERHEAD = 350
const POSTING_ENTRY_SIZE = 24
const PER_TERM_OVERHEAD = 180
const SURFACE_ENTRY_OVERHEAD = 140
const FIELD_ENTRY_OVERHEAD = 42

export function estimatePartitionBytes(state: PartitionReadState): number {
  const docCount = state.docStore.count()
  if (docCount === 0) return 0

  let bytes = docCount * AVG_DOC_OVERHEAD

  const docFreqs = state.stats.docFrequencies
  let totalPostings = 0
  let termCount = 0
  for (const term in docFreqs) {
    totalPostings += docFreqs[term]
    termCount++
  }
  bytes += totalPostings * POSTING_ENTRY_SIZE
  bytes += termCount * PER_TERM_OVERHEAD
  bytes += state.surfaceRegistry.size() * SURFACE_ENTRY_OVERHEAD

  bytes += docCount * state.numericIndexes.size * FIELD_ENTRY_OVERHEAD
  bytes += docCount * state.booleanIndexes.size * FIELD_ENTRY_OVERHEAD
  bytes += docCount * state.enumIndexes.size * FIELD_ENTRY_OVERHEAD
  bytes += docCount * state.geoIndexes.size * FIELD_ENTRY_OVERHEAD

  return bytes + sortColumnBytes(state)
}
