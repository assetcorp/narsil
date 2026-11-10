import type { NativeKeywordMergeInput } from '../../vector/native/types/segment-merge'
import type { FrozenSegment } from '../partition/frozen'
import type { PartitionReadState } from '../partition/read-state'

const sources = new WeakMap<PartitionReadState, FrozenSegment['arrays']>()

export function registerFrozenMergeSource(segment: FrozenSegment): void {
  if (segment.paged === null) sources.set(segment, segment.arrays)
}

export function frozenMergeSource(
  state: PartitionReadState,
): Pick<
  NativeKeywordMergeInput,
  | 'terms'
  | 'payloadSlots'
  | 'postingOffsets'
  | 'postingDocuments'
  | 'postingFrequencies'
  | 'postingFields'
  | 'positionOffsets'
  | 'positionValues'
> | null {
  const arrays = sources.get(state)
  if (arrays === undefined) return null
  const terms = arrays.tokenTable.data
  return {
    terms: { text: terms.blob, offsets: terms.offsets, counts: terms.documentFrequencies },
    payloadSlots: terms.payloadSlots,
    postingOffsets: arrays.postingOffsets,
    postingDocuments: arrays.postingDocIds,
    postingFrequencies: arrays.postingFrequencies,
    postingFields: arrays.postingFieldIndices,
    positionOffsets: arrays.positionOffsets,
    positionValues: arrays.positionValues,
  }
}
