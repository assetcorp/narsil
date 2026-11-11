import { bindFrozenKernelHost, type FrozenKernelHost } from '../core/frozen-writes/kernel-host.browser'
import { growFrozenRemovalRegions } from '../core/frozen-writes/pending-writes'
import { prepareFrozenRemoval, removeFrozenDocument, settleFrozenState } from '../core/frozen-writes/portable'
import { prepareFrozenStrings } from '../core/frozen-writes/removal-strings'
import type * as SegmentCodecCode from '../core/segment-codec-leaf'
import { bindSegmentRemovalHost, type SegmentRemovalHost } from '../core/segment-writes/removal-host.browser'
import { removeDocument } from '../core/segment-writes/remove'
import type { OptionalCodeHost } from './optional-code-host'

type FrozenRemovalNames = FrozenKernelHost &
  SegmentRemovalHost &
  Pick<OptionalCodeHost, 'bindFrozenRemovalKernel' | 'bindSegmentRemoval'>

type EngineNames = Pick<
  OptionalCodeHost,
  | 'BATCH_CHUNK_SIZE'
  | 'ErrorCodes'
  | 'MIN_DOCUMENTS_FOR_SEGMENTS'
  | 'NarsilError'
  | 'admitBufferedUpsert'
  | 'admitInsert'
  | 'arrayPositionsAreStale'
  | 'asBatchInsertError'
  | 'awaitWriteVisibility'
  | 'changeIndexOutsideExternalWaits'
  | 'collectRequiredFieldFailures'
  | 'createFrozenSegment'
  | 'createPendingAdmissions'
  | 'deleteNestedValue'
  | 'embedChunkDocuments'
  | 'emitSyncChange'
  | 'extractVectorFromDoc'
  | 'fnv1a'
  | 'generateId'
  | 'getLanguage'
  | 'getNestedValue'
  | 'getVectorFieldPaths'
  | 'indexChangeOutsideExternalWaits'
  | 'insertDocument'
  | 'insertDocumentVectors'
  | 'isSyncEpoch'
  | 'loadEmbedCode'
  | 'loadSchemaCodeFor'
  | 'loadStorageCode'
  | 'lookupOfStoredSynonyms'
  | 'newSyncEpoch'
  | 'oneAtATime'
  | 'prepareDocumentVectors'
  | 'prepareStoredSynonyms'
  | 'providedDocId'
  | 'readHeapStatistics'
  | 'recordPendingAdmission'
  | 'removeDocumentVectors'
  | 'requireDocumentObject'
  | 'requireDocumentWithinSizeLimit'
  | 'requireMatchingDocId'
  | 'requireSurfaceFormsForPartialFields'
  | 'storedBM25Params'
  | 'turnIsSpent'
  | 'turnsAreBudgeted'
  | 'updateDocumentVectors'
  | 'validateBM25Params'
  | 'validateBatchList'
  | 'validateDocId'
  | 'validateDocument'
  | 'validateDocumentStrict'
  | 'validateEmbeddingConfig'
  | 'validatePartitionConfig'
  | 'validatePatternValueLimit'
  | 'validateRequiredFields'
  | 'validateSchema'
  | 'validateTextStorage'
  | 'validateVectorDimensions'
  | 'validateVectorStorage'
  | 'withOpenIndex'
  | 'yieldTurn'
>
type SegmentCodecNames = Pick<typeof SegmentCodecCode, 'createSharedFrozenSegment' | 'reconstructSchemaFromMetadata'>

export let BATCH_CHUNK_SIZE: EngineNames['BATCH_CHUNK_SIZE']
export let ErrorCodes: EngineNames['ErrorCodes']
export let MIN_DOCUMENTS_FOR_SEGMENTS: EngineNames['MIN_DOCUMENTS_FOR_SEGMENTS']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>
export let admitBufferedUpsert: EngineNames['admitBufferedUpsert']
export let admitInsert: EngineNames['admitInsert']
export let arrayPositionsAreStale: EngineNames['arrayPositionsAreStale']
export let asBatchInsertError: EngineNames['asBatchInsertError']
export let awaitWriteVisibility: EngineNames['awaitWriteVisibility']
export let changeIndexOutsideExternalWaits: EngineNames['changeIndexOutsideExternalWaits']
export let collectRequiredFieldFailures: EngineNames['collectRequiredFieldFailures']
export let createFrozenSegment: EngineNames['createFrozenSegment']
export let createPendingAdmissions: EngineNames['createPendingAdmissions']
export let deleteNestedValue: EngineNames['deleteNestedValue']
export let embedChunkDocuments: EngineNames['embedChunkDocuments']
export let emitSyncChange: EngineNames['emitSyncChange']
export let extractVectorFromDoc: EngineNames['extractVectorFromDoc']
export let fnv1a: EngineNames['fnv1a']
export let generateId: EngineNames['generateId']
export let getLanguage: EngineNames['getLanguage']
export let getNestedValue: EngineNames['getNestedValue']
export let getVectorFieldPaths: EngineNames['getVectorFieldPaths']
export let indexChangeOutsideExternalWaits: EngineNames['indexChangeOutsideExternalWaits']
export let insertDocument: EngineNames['insertDocument']
export let insertDocumentVectors: EngineNames['insertDocumentVectors']
export let isSyncEpoch: EngineNames['isSyncEpoch']
export let loadEmbedCode: EngineNames['loadEmbedCode']
export let loadSchemaCodeFor: EngineNames['loadSchemaCodeFor']
export let loadStorageCode: EngineNames['loadStorageCode']
export let lookupOfStoredSynonyms: EngineNames['lookupOfStoredSynonyms']
export let newSyncEpoch: EngineNames['newSyncEpoch']
export let oneAtATime: EngineNames['oneAtATime']
export let prepareDocumentVectors: EngineNames['prepareDocumentVectors']
export let prepareStoredSynonyms: EngineNames['prepareStoredSynonyms']
export let providedDocId: EngineNames['providedDocId']
export let readHeapStatistics: EngineNames['readHeapStatistics']
export let recordPendingAdmission: EngineNames['recordPendingAdmission']
export let removeDocumentVectors: EngineNames['removeDocumentVectors']
export let requireDocumentObject: EngineNames['requireDocumentObject']
export let requireDocumentWithinSizeLimit: EngineNames['requireDocumentWithinSizeLimit']
export let requireMatchingDocId: EngineNames['requireMatchingDocId']
export let requireSurfaceFormsForPartialFields: EngineNames['requireSurfaceFormsForPartialFields']
export let storedBM25Params: EngineNames['storedBM25Params']
export let turnIsSpent: EngineNames['turnIsSpent']
export let turnsAreBudgeted: EngineNames['turnsAreBudgeted']
export let updateDocumentVectors: EngineNames['updateDocumentVectors']
export let validateBM25Params: EngineNames['validateBM25Params']
export let validateBatchList: EngineNames['validateBatchList']
export let validateDocId: EngineNames['validateDocId']
export let validateDocument: EngineNames['validateDocument']
export let validateDocumentStrict: EngineNames['validateDocumentStrict']
export let validateEmbeddingConfig: EngineNames['validateEmbeddingConfig']
export let validatePartitionConfig: EngineNames['validatePartitionConfig']
export let validatePatternValueLimit: EngineNames['validatePatternValueLimit']
export let validateRequiredFields: EngineNames['validateRequiredFields']
export let validateSchema: EngineNames['validateSchema']
export let validateTextStorage: EngineNames['validateTextStorage']
export let validateVectorDimensions: EngineNames['validateVectorDimensions']
export let validateVectorStorage: EngineNames['validateVectorStorage']
export let withOpenIndex: EngineNames['withOpenIndex']
export let yieldTurn: EngineNames['yieldTurn']
export let createSharedFrozenSegment: SegmentCodecNames['createSharedFrozenSegment']
export let reconstructSchemaFromMetadata: SegmentCodecNames['reconstructSchemaFromMetadata']

export function bindOptionalWritesHost(host: EngineNames & FrozenRemovalNames, segmentCodec: SegmentCodecNames): void {
  bindFrozenKernelHost(host)
  host.bindFrozenRemovalKernel({
    growFrozenRemovalRegions,
    prepareFrozenRemoval,
    prepareFrozenStrings,
    removeFrozenDocument,
    settleFrozenState,
  })
  bindSegmentRemovalHost(host)
  host.bindSegmentRemoval(removeDocument)
  ;({
    BATCH_CHUNK_SIZE,
    ErrorCodes,
    MIN_DOCUMENTS_FOR_SEGMENTS,
    NarsilError,
    admitBufferedUpsert,
    admitInsert,
    arrayPositionsAreStale,
    asBatchInsertError,
    awaitWriteVisibility,
    changeIndexOutsideExternalWaits,
    collectRequiredFieldFailures,
    createFrozenSegment,
    createPendingAdmissions,
    deleteNestedValue,
    embedChunkDocuments,
    emitSyncChange,
    extractVectorFromDoc,
    fnv1a,
    generateId,
    getLanguage,
    getNestedValue,
    getVectorFieldPaths,
    indexChangeOutsideExternalWaits,
    insertDocument,
    insertDocumentVectors,
    isSyncEpoch,
    loadEmbedCode,
    loadSchemaCodeFor,
    loadStorageCode,
    lookupOfStoredSynonyms,
    newSyncEpoch,
    oneAtATime,
    prepareDocumentVectors,
    prepareStoredSynonyms,
    providedDocId,
    readHeapStatistics,
    recordPendingAdmission,
    removeDocumentVectors,
    requireDocumentObject,
    requireDocumentWithinSizeLimit,
    requireMatchingDocId,
    requireSurfaceFormsForPartialFields,
    storedBM25Params,
    turnIsSpent,
    turnsAreBudgeted,
    updateDocumentVectors,
    validateBM25Params,
    validateBatchList,
    validateDocId,
    validateDocument,
    validateDocumentStrict,
    validateEmbeddingConfig,
    validatePartitionConfig,
    validatePatternValueLimit,
    validateRequiredFields,
    validateSchema,
    validateTextStorage,
    validateVectorDimensions,
    validateVectorStorage,
    withOpenIndex,
    yieldTurn,
  } = host)
  ;({ createSharedFrozenSegment, reconstructSchemaFromMetadata } = segmentCodec)
}
