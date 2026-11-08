export { bindSegmentMergeHost } from '#platform/segment-merge-host'
export {
  alreadyPresentOnWorker,
  eligibleIndexNames,
  isDeterministicFailure,
  reportIneligible,
  toError,
  workerIneligibility,
} from '../engine/orchestration/eligibility'
export { createRequestId, isValidWorkerResponse } from '../workers/protocol'
export { fieldIndexRemapOf, holdsADiscardedField, mergeSegmentContents, selectionKeeps } from './partition/frozen/merge'
export { mergeFieldIndexes } from './partition/frozen/merge-fields'
export {
  freezeEncodedSegmentShared,
  freezeSegmentShared,
  segmentArraysOf,
  shareSegmentArrays,
} from './partition/frozen/shared-snapshot'
export { buildSegmentPayloads } from './partition/segment-builder'
export { deserializePartition, serializePartition } from './partition/serialization'
export { mergedPartialSpellings, mergeSourceSpellings, mergeSourceSurfaces } from './segment-merges/host'
