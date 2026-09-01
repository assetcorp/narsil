import { sortColumnBytes } from './sorting'
import type { PartitionReadState } from './utils'

const DOC_ENTRY_OVERHEAD_BYTES = 260
const LENGTH_COLUMN_SLOT_BYTES = 6
const POSTING_ENTRY_BYTES = 40
const POSITIONS_ARRAY_OVERHEAD_BYTES = 88
const POSITION_BYTES = 8
const PER_TERM_OVERHEAD_BYTES = 180
const SURFACE_ENTRY_OVERHEAD_BYTES = 140
const FIELD_ENTRY_OVERHEAD_BYTES = 42

export function estimatePartitionBytes(state: PartitionReadState): number {
  const docCount = state.docStore.count()
  if (docCount === 0) return 0

  const docFreqs = state.stats.docFrequencies
  let totalPostings = 0
  let termCount = 0
  for (const term in docFreqs) {
    totalPostings += docFreqs[term]
    termCount++
  }

  const fieldLengthTotals = state.stats.totalFieldLengths
  let totalTokenOccurrences = 0
  let textFieldCount = 0
  for (const field in fieldLengthTotals) {
    totalTokenOccurrences += fieldLengthTotals[field]
    textFieldCount++
  }

  let bytes = state.docStore.contentBytes()
  bytes += docCount * DOC_ENTRY_OVERHEAD_BYTES
  bytes += textFieldCount * state.docStore.internalIdCapacity() * LENGTH_COLUMN_SLOT_BYTES
  bytes += totalPostings * POSTING_ENTRY_BYTES
  if (state.trackPositions) {
    bytes += totalPostings * POSITIONS_ARRAY_OVERHEAD_BYTES
    bytes += totalTokenOccurrences * POSITION_BYTES
  }
  bytes += termCount * PER_TERM_OVERHEAD_BYTES
  bytes += state.surfaceRegistry.size() * SURFACE_ENTRY_OVERHEAD_BYTES

  bytes += docCount * state.numericIndexes.size * FIELD_ENTRY_OVERHEAD_BYTES
  bytes += docCount * state.booleanIndexes.size * FIELD_ENTRY_OVERHEAD_BYTES
  bytes += docCount * state.enumIndexes.size * FIELD_ENTRY_OVERHEAD_BYTES
  bytes += docCount * state.geoIndexes.size * FIELD_ENTRY_OVERHEAD_BYTES

  return bytes + sortColumnBytes(state)
}
