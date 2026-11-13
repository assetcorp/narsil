import type * as SegmentCodecCode from '../../core/segment-codec-leaf'
import type * as SegmentMergeCode from '../../core/segment-merge-leaf'
import type { OptionalCodeHost } from '../optional-code-host'

type EngineNames = Pick<
  OptionalCodeHost,
  | 'COMPACTION_SEGMENT_TRIGGER'
  | 'DEFAULT_BACKPRESSURE_LIMIT'
  | 'DEFAULT_COPY_IDLE_TIMEOUT_MS'
  | 'DEFAULT_COPY_THRESHOLD'
  | 'DEFAULT_REQUEST_TIMEOUT_MS'
  | 'ErrorCodes'
  | 'IDLE_MERGE_DELAY_MS'
  | 'LIVE_TAIL_FLUSH_DOCUMENTS'
  | 'LIVE_TAIL_FREEZE_FLOOR'
  | 'LOAD_BUFFER_YIELD_INTERVAL'
  | 'LONG_QUERY_THREADS'
  | 'MAIN_COPY_LONE_QUERY_DOCUMENTS'
  | 'MATCHER_STATE_BUDGET_BYTES'
  | 'MAX_PENDING_REPLICATION_DOCUMENTS'
  | 'MAX_SWEEP_INTERVAL_MS'
  | 'MIN_SWEEP_INTERVAL_MS'
  | 'NO_REMOVED_SPELLINGS'
  | 'NarsilError'
  | 'POOL_RESTART_DELAY_MAX_MS'
  | 'POOL_RESTART_DELAY_MS'
  | 'REPLICATION_WINDOW'
  | 'RETIRED_THREADS_EXIT_WAIT_MS'
  | 'SEGMENTS_PER_MERGE'
  | 'SHUTDOWN_TIMEOUT_MS'
  | 'SegmentRefusal'
  | 'WORKER_SILENCE_BEFORE_DEATH_MS'
  | 'WORKER_SILENCE_BEFORE_PROBE_MS'
  | 'afterCurrentTurn'
  | 'availablePatternSearch'
  | 'createWorkerFactory'
  | 'encodeSegmentState'
  | 'extractVectorFieldsFromSchema'
  | 'fnv1a'
  | 'generateId'
  | 'growPartitionsTo'
  | 'isCompositePartition'
  | 'kWayMerge'
  | 'loadStorageCode'
  | 'mergeFacets'
  | 'noteThreadSlotGone'
  | 'oversampledFacetConfig'
  | 'patternHost'
  | 'prepareDocumentVectors'
  | 'requireLoadedVectorCode'
  | 'resolvePartitionInsertOptions'
  | 'resolveRequestThreadCount'
  | 'resolveWorkerCount'
  | 'returnsEveryMatch'
  | 'schemaFieldsOf'
  | 'splitWorkerBudget'
  | 'threadSlotOfWorker'
  | 'workersEnabledByDefault'
  | 'yieldToEventLoop'
>
type SegmentCodecNames = Pick<typeof SegmentCodecCode, 'createSharedFrozenSegment'>
type SegmentMergeNames = Pick<
  typeof SegmentMergeCode,
  | 'alreadyPresentOnWorker'
  | 'buildSegmentPayloads'
  | 'createRequestId'
  | 'eligibleIndexNames'
  | 'freezeEncodedSegmentShared'
  | 'freezeSegmentShared'
  | 'isDeterministicFailure'
  | 'isValidWorkerResponse'
  | 'mergeSegmentContents'
  | 'reportIneligible'
  | 'selectionKeeps'
  | 'toError'
  | 'workerIneligibility'
>

export let COMPACTION_SEGMENT_TRIGGER: EngineNames['COMPACTION_SEGMENT_TRIGGER']
export let DEFAULT_BACKPRESSURE_LIMIT: EngineNames['DEFAULT_BACKPRESSURE_LIMIT']
export let DEFAULT_COPY_IDLE_TIMEOUT_MS: EngineNames['DEFAULT_COPY_IDLE_TIMEOUT_MS']
export let DEFAULT_COPY_THRESHOLD: EngineNames['DEFAULT_COPY_THRESHOLD']
export let DEFAULT_REQUEST_TIMEOUT_MS: EngineNames['DEFAULT_REQUEST_TIMEOUT_MS']
export let ErrorCodes: EngineNames['ErrorCodes']
export let IDLE_MERGE_DELAY_MS: EngineNames['IDLE_MERGE_DELAY_MS']
export let LIVE_TAIL_FLUSH_DOCUMENTS: EngineNames['LIVE_TAIL_FLUSH_DOCUMENTS']
export let LIVE_TAIL_FREEZE_FLOOR: EngineNames['LIVE_TAIL_FREEZE_FLOOR']
export let LOAD_BUFFER_YIELD_INTERVAL: EngineNames['LOAD_BUFFER_YIELD_INTERVAL']
export let LONG_QUERY_THREADS: EngineNames['LONG_QUERY_THREADS']
export let MAIN_COPY_LONE_QUERY_DOCUMENTS: EngineNames['MAIN_COPY_LONE_QUERY_DOCUMENTS']
export let MATCHER_STATE_BUDGET_BYTES: EngineNames['MATCHER_STATE_BUDGET_BYTES']
export let MAX_PENDING_REPLICATION_DOCUMENTS: EngineNames['MAX_PENDING_REPLICATION_DOCUMENTS']
export let MAX_SWEEP_INTERVAL_MS: EngineNames['MAX_SWEEP_INTERVAL_MS']
export let MIN_SWEEP_INTERVAL_MS: EngineNames['MIN_SWEEP_INTERVAL_MS']
export let NO_REMOVED_SPELLINGS: EngineNames['NO_REMOVED_SPELLINGS']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>
export let POOL_RESTART_DELAY_MAX_MS: EngineNames['POOL_RESTART_DELAY_MAX_MS']
export let POOL_RESTART_DELAY_MS: EngineNames['POOL_RESTART_DELAY_MS']
export let REPLICATION_WINDOW: EngineNames['REPLICATION_WINDOW']
export let RETIRED_THREADS_EXIT_WAIT_MS: EngineNames['RETIRED_THREADS_EXIT_WAIT_MS']
export let SEGMENTS_PER_MERGE: EngineNames['SEGMENTS_PER_MERGE']
export let SHUTDOWN_TIMEOUT_MS: EngineNames['SHUTDOWN_TIMEOUT_MS']
export let SegmentRefusal: EngineNames['SegmentRefusal']
export type SegmentRefusal = InstanceType<EngineNames['SegmentRefusal']>
export let WORKER_SILENCE_BEFORE_DEATH_MS: EngineNames['WORKER_SILENCE_BEFORE_DEATH_MS']
export let WORKER_SILENCE_BEFORE_PROBE_MS: EngineNames['WORKER_SILENCE_BEFORE_PROBE_MS']
export let afterCurrentTurn: EngineNames['afterCurrentTurn']
export let availablePatternSearch: EngineNames['availablePatternSearch']
export let createWorkerFactory: EngineNames['createWorkerFactory']
export let encodeSegmentState: EngineNames['encodeSegmentState']
export let extractVectorFieldsFromSchema: EngineNames['extractVectorFieldsFromSchema']
export let fnv1a: EngineNames['fnv1a']
export let generateId: EngineNames['generateId']
export let growPartitionsTo: EngineNames['growPartitionsTo']
export let isCompositePartition: EngineNames['isCompositePartition']
export let kWayMerge: EngineNames['kWayMerge']
export let loadStorageCode: EngineNames['loadStorageCode']
export let mergeFacets: EngineNames['mergeFacets']
export let noteThreadSlotGone: EngineNames['noteThreadSlotGone']
export let oversampledFacetConfig: EngineNames['oversampledFacetConfig']
export let patternHost: EngineNames['patternHost']
export let prepareDocumentVectors: EngineNames['prepareDocumentVectors']
export let requireLoadedVectorCode: EngineNames['requireLoadedVectorCode']
export let resolvePartitionInsertOptions: EngineNames['resolvePartitionInsertOptions']
export let resolveRequestThreadCount: EngineNames['resolveRequestThreadCount']
export let resolveWorkerCount: EngineNames['resolveWorkerCount']
export let returnsEveryMatch: EngineNames['returnsEveryMatch']
export let schemaFieldsOf: EngineNames['schemaFieldsOf']
export let splitWorkerBudget: EngineNames['splitWorkerBudget']
export let threadSlotOfWorker: EngineNames['threadSlotOfWorker']
export let workersEnabledByDefault: EngineNames['workersEnabledByDefault']
export let yieldToEventLoop: EngineNames['yieldToEventLoop']
export let createSharedFrozenSegment: SegmentCodecNames['createSharedFrozenSegment']
export let alreadyPresentOnWorker: SegmentMergeNames['alreadyPresentOnWorker']
export let buildSegmentPayloads: SegmentMergeNames['buildSegmentPayloads']
export let createRequestId: SegmentMergeNames['createRequestId']
export let eligibleIndexNames: SegmentMergeNames['eligibleIndexNames']
export let freezeEncodedSegmentShared: SegmentMergeNames['freezeEncodedSegmentShared']
export let freezeSegmentShared: SegmentMergeNames['freezeSegmentShared']
export let isDeterministicFailure: SegmentMergeNames['isDeterministicFailure']
export let isValidWorkerResponse: SegmentMergeNames['isValidWorkerResponse']
export let mergeSegmentContents: SegmentMergeNames['mergeSegmentContents']
export let reportIneligible: SegmentMergeNames['reportIneligible']
export let selectionKeeps: SegmentMergeNames['selectionKeeps']
export let toError: SegmentMergeNames['toError']
export let workerIneligibility: SegmentMergeNames['workerIneligibility']

export function bindWorkerCopiesHost(
  host: EngineNames,
  segmentCodec: SegmentCodecNames,
  segmentMerge: SegmentMergeNames,
): void {
  ;({
    COMPACTION_SEGMENT_TRIGGER,
    DEFAULT_BACKPRESSURE_LIMIT,
    DEFAULT_COPY_IDLE_TIMEOUT_MS,
    DEFAULT_COPY_THRESHOLD,
    DEFAULT_REQUEST_TIMEOUT_MS,
    ErrorCodes,
    IDLE_MERGE_DELAY_MS,
    LIVE_TAIL_FLUSH_DOCUMENTS,
    LIVE_TAIL_FREEZE_FLOOR,
    LOAD_BUFFER_YIELD_INTERVAL,
    LONG_QUERY_THREADS,
    MAIN_COPY_LONE_QUERY_DOCUMENTS,
    MATCHER_STATE_BUDGET_BYTES,
    MAX_PENDING_REPLICATION_DOCUMENTS,
    MAX_SWEEP_INTERVAL_MS,
    MIN_SWEEP_INTERVAL_MS,
    NO_REMOVED_SPELLINGS,
    NarsilError,
    POOL_RESTART_DELAY_MAX_MS,
    POOL_RESTART_DELAY_MS,
    REPLICATION_WINDOW,
    RETIRED_THREADS_EXIT_WAIT_MS,
    SEGMENTS_PER_MERGE,
    SHUTDOWN_TIMEOUT_MS,
    SegmentRefusal,
    WORKER_SILENCE_BEFORE_DEATH_MS,
    WORKER_SILENCE_BEFORE_PROBE_MS,
    afterCurrentTurn,
    availablePatternSearch,
    createWorkerFactory,
    encodeSegmentState,
    extractVectorFieldsFromSchema,
    fnv1a,
    generateId,
    growPartitionsTo,
    isCompositePartition,
    kWayMerge,
    loadStorageCode,
    mergeFacets,
    noteThreadSlotGone,
    oversampledFacetConfig,
    patternHost,
    prepareDocumentVectors,
    requireLoadedVectorCode,
    resolvePartitionInsertOptions,
    resolveRequestThreadCount,
    resolveWorkerCount,
    returnsEveryMatch,
    schemaFieldsOf,
    splitWorkerBudget,
    threadSlotOfWorker,
    workersEnabledByDefault,
    yieldToEventLoop,
  } = host)
  ;({ createSharedFrozenSegment } = segmentCodec)
  ;({
    alreadyPresentOnWorker,
    buildSegmentPayloads,
    createRequestId,
    eligibleIndexNames,
    freezeEncodedSegmentShared,
    freezeSegmentShared,
    isDeterministicFailure,
    isValidWorkerResponse,
    mergeSegmentContents,
    reportIneligible,
    selectionKeeps,
    toError,
    workerIneligibility,
  } = segmentMerge)
}
