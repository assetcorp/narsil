import type { NativeGrowingSegment } from '../../vector/native/types/segments'
import { SLICE_CAPACITIES } from '../inverted-index/pools'
import { growingKeywordRegions } from '../partition/keyword-writes'
import type { PartitionReadState } from '../partition/read-state'

export function growingMergeSource(state: PartitionReadState): NativeGrowingSegment | null {
  const held = growingKeywordRegions(state)
  if (held !== null) return held
  const postings = state.invertedIdx.livePostings
  if (postings === undefined) return null
  const { pool, terms, positions } = postings
  const fields = state.fieldNameTable.names
  const ordinalCapacity = state.docStore.internalIdCapacity()
  const fieldLengths = new Uint32Array(ordinalCapacity * fields.length)
  const totalFieldLengths = new Float64Array(fields.length)
  for (let field = 0; field < fields.length; field++) {
    const column = state.docStore.fieldLengthColumn(fields[field])
    if (column !== null) fieldLengths.set(column.subarray(0, ordinalCapacity), field * ordinalCapacity)
    totalFieldLengths[field] = state.stats.totalFieldLengths[fields[field]] ?? 0
  }
  const words = Math.max(1, Math.ceil(ordinalCapacity / 32))
  let retired = postings.retired.subarray(0, words)
  if (retired.length < words) {
    retired = new Uint32Array(words)
    retired.set(postings.retired)
  }
  return {
    terms: terms.ids,
    columns: terms,
    postings: {
      docIds: pool.docIds,
      frequencies: pool.frequencies,
      fieldIndices: pool.fieldIndices,
      positionStarts: pool.positionStarts,
      allocation: pool.allocation,
      freeHeads: pool.freeHeads,
      sliceCapacities: SLICE_CAPACITIES,
    },
    positions: pool.positionStarts === null ? null : { values: positions.values, allocation: positions.allocation },
    surfaces: null,
    spellings: null,
    retired,
    fieldLengths,
    totalDocuments: Uint32Array.of(state.docStore.count()),
    totalFieldLengths,
    partialFields: new Uint8Array(fields.length),
    ordinalCapacity,
  }
}
