import { storedValueBytes } from '../stored-values/columns'
import { keywordSegmentBytes } from './keyword-writes'
import { sortColumnBytes } from './sorting'
import type { PartitionState } from './utils'

const DOC_ENTRY_OVERHEAD_BYTES = 260
const LENGTH_COLUMN_SLOT_BYTES = 6
const SURFACE_ENTRY_OVERHEAD_BYTES = 140
const FIELD_ENTRY_OVERHEAD_BYTES = 42

export function estimatePartitionBytes(state: PartitionState): number {
  const docCount = state.docStore.count()
  let fieldBytes = storedValueBytes(state.docStore) + state.docStore.liveOrdinalBytes() + keywordSegmentBytes(state)
  for (const index of state.numericIndexes.values()) fieldBytes += index.bytes()
  for (const index of state.sizeIndexes.values()) fieldBytes += index.bytes()
  for (const index of state.enumIndexes.values()) fieldBytes += index.regionBytes()
  for (const index of state.booleanIndexes.values()) fieldBytes += index.regionBytes()
  for (const index of state.geoIndexes.values()) fieldBytes += index.regionBytes()
  if (docCount === 0) return fieldBytes

  const textFieldCount = Object.keys(state.stats.totalFieldLengths).length

  let bytes = state.docStore.contentBytes() + fieldBytes
  bytes += docCount * DOC_ENTRY_OVERHEAD_BYTES
  bytes += textFieldCount * state.docStore.internalIdCapacity() * LENGTH_COLUMN_SLOT_BYTES
  bytes += state.invertedIdx.estimateBytes()
  bytes += state.surfaceRegistry.size() * SURFACE_ENTRY_OVERHEAD_BYTES

  bytes += docCount * state.enumIndexes.size * FIELD_ENTRY_OVERHEAD_BYTES
  bytes += docCount * state.geoIndexes.size * FIELD_ENTRY_OVERHEAD_BYTES
  for (const index of state.patternIndexes.values()) bytes += index.bytes()
  bytes += state.partialWords.bytes()

  return bytes + sortColumnBytes(state) + (state.vectorOrdinalMaps?.bytes ?? 0)
}
