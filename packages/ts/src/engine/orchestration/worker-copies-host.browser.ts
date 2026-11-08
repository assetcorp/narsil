import type * as SegmentCodecCode from '../../core/segment-codec-leaf'
import type * as SegmentMergeCode from '../../core/segment-merge-leaf'
import type { OptionalCodeHost } from '../optional-code-host'

type EngineNames = Pick<
  OptionalCodeHost,
  | 'ErrorCodes'
  | 'LIVE_TAIL_FREEZE_FLOOR'
  | 'NO_REMOVED_SPELLINGS'
  | 'NarsilError'
  | 'SegmentRefusal'
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

export let ErrorCodes: EngineNames['ErrorCodes']
export let LIVE_TAIL_FREEZE_FLOOR: EngineNames['LIVE_TAIL_FREEZE_FLOOR']
export let NO_REMOVED_SPELLINGS: EngineNames['NO_REMOVED_SPELLINGS']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>
export let SegmentRefusal: EngineNames['SegmentRefusal']
export type SegmentRefusal = InstanceType<EngineNames['SegmentRefusal']>
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
    ErrorCodes,
    LIVE_TAIL_FREEZE_FLOOR,
    NO_REMOVED_SPELLINGS,
    NarsilError,
    SegmentRefusal,
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
