import type * as SegmentCodecCode from '../../core/segment-codec-leaf'
import type * as SegmentMergeCode from '../../core/segment-merge-leaf'
import type { OptionalCodeHost } from '../optional-code-host'

export { createWorkerFactory } from '#platform/worker-factory'
export { fnv1a } from '../../core/hash'
export { generateId } from '../../core/id-generator'
export { isCompositePartition } from '../../core/partition/composite'
export { mergeSegmentContents, selectionKeeps } from '../../core/partition/frozen/merge'
export { NO_REMOVED_SPELLINGS } from '../../core/partition/frozen/removal-pass'
export { createSharedFrozenSegment } from '../../core/partition/frozen/shared'
export { freezeEncodedSegmentShared, freezeSegmentShared } from '../../core/partition/frozen/shared-snapshot'
export { buildSegmentPayloads } from '../../core/partition/segment-builder'
export { encodeSegmentState } from '../../core/partition/segment-payload'
export { patternHost } from '../../core/pattern-index/host'
export { availablePatternSearch } from '../../core/pattern-index/registry'
export { SegmentRefusal } from '../../core/segment-writes/status'
export { ErrorCodes, NarsilError } from '../../errors'
export { kWayMerge } from '../../partitioning/fan-out'
export { resolvePartitionInsertOptions } from '../../partitioning/insert-options'
export { loadStorageCode } from '../../persistence/storage-code'
export { extractVectorFieldsFromSchema } from '../../schema/validator'
export { schemaFieldsOf } from '../../schema/validator/schema'
export { mergeFacets, oversampledFacetConfig } from '../../search/facets'
export { returnsEveryMatch } from '../../search/fulltext'
export { createRequestId, isValidWorkerResponse } from '../../workers/protocol'
export { growPartitionsTo } from '../../workers/segment-action-code'
export { noteThreadSlotGone, threadSlotOfWorker } from '../../workers/thread-slot'
export { requireLoadedVectorCode } from '../../workers/vector-code'
export { resolveRequestThreadCount, resolveWorkerCount, splitWorkerBudget } from '../../workers/worker-count'
export { prepareDocumentVectors } from '../vector-coordinator'
export { LIVE_TAIL_FREEZE_FLOOR } from './constants'
export {
  alreadyPresentOnWorker,
  eligibleIndexNames,
  isDeterministicFailure,
  reportIneligible,
  toError,
  workerIneligibility,
} from './eligibility'
export { workersEnabledByDefault } from './loader'
export { afterCurrentTurn, yieldToEventLoop } from './turn'

export function bindWorkerCopiesHost(
  _host: OptionalCodeHost,
  _segmentCodec: typeof SegmentCodecCode,
  _segmentMerge: typeof SegmentMergeCode,
): void {}
