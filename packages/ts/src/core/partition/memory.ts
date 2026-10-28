import { sortColumnBytes } from './sorting'
import type { PartitionState } from './utils'

const DOC_ENTRY_OVERHEAD_BYTES = 260
const LENGTH_COLUMN_SLOT_BYTES = 6
const DOC_FREQUENCY_ENTRY_BYTES = 44
const SURFACE_ENTRY_OVERHEAD_BYTES = 140
const FIELD_ENTRY_OVERHEAD_BYTES = 42

export function estimatePartitionBytes(state: PartitionState): number {
  const docCount = state.docStore.count()
  if (docCount === 0) return 0

  const textFieldCount = Object.keys(state.stats.totalFieldLengths).length

  let bytes = state.docStore.contentBytes()
  bytes += docCount * DOC_ENTRY_OVERHEAD_BYTES
  bytes += textFieldCount * state.docStore.internalIdCapacity() * LENGTH_COLUMN_SLOT_BYTES
  bytes += state.invertedIdx.estimateBytes()
  bytes += state.invertedIdx.size() * DOC_FREQUENCY_ENTRY_BYTES
  bytes += state.surfaceRegistry.size() * SURFACE_ENTRY_OVERHEAD_BYTES

  bytes += docCount * state.numericIndexes.size * FIELD_ENTRY_OVERHEAD_BYTES
  bytes += docCount * state.booleanIndexes.size * FIELD_ENTRY_OVERHEAD_BYTES
  bytes += docCount * state.enumIndexes.size * FIELD_ENTRY_OVERHEAD_BYTES
  bytes += docCount * state.geoIndexes.size * FIELD_ENTRY_OVERHEAD_BYTES
  bytes += docCount * state.sizeIndexes.size * FIELD_ENTRY_OVERHEAD_BYTES
  for (const index of state.patternIndexes.values()) bytes += index.bytes()
  bytes += state.partialWords.bytes()

  return bytes + sortColumnBytes(state)
}
