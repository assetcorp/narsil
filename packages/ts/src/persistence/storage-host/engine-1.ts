import type { OptionalCodeHost } from '../../engine/optional-code-host'

type Engine1Names = Pick<
  OptionalCodeHost,
  | 'ANALYSIS_CHANGE_MEMBERS'
  | 'ErrorCodes'
  | 'INDEX_NAME_PATTERN'
  | 'NarsilError'
  | 'SegmentRefusal'
  | 'TermLookup'
  | 'VALID_HNSW_METRICS'
  | 'VECTOR_FILE_MAX_VECTORS'
  | 'VECTOR_PATTERN'
  | 'arrayPositionsAreStale'
  | 'assembleGraphParts'
  | 'assemblePagedFrozenSegment'
  | 'attachedRuntimeOf'
  | 'buildPartialWordTableFrom'
  | 'bytesToVectors'
  | 'checksumOfChunks'
  | 'chunksOf'
  | 'compareCodePoints'
  | 'compareScores'
  | 'configUnderAnalysis'
  | 'configurationPayloadOf'
  | 'countDead'
  | 'countWrite'
  | 'crc32'
  | 'crc32Final'
  | 'crc32Init'
  | 'crc32Update'
  | 'createByteReader'
  | 'createCompositePartition'
  | 'createFrozenSegment'
  | 'createPartitionIndex'
  | 'createPartitionManager'
  | 'createPartitionRouter'
  | 'createPublicationGate'
  | 'deadBytesFor'
  | 'decode'
  | 'decodeIndexConfiguration'
  | 'decodeMulti'
  | 'decodeSegmentManifest'
  | 'decodeSurfaceTable'
  | 'decodeVectorFilePayload'
  | 'decodeVectorGraphPartPayload'
  | 'decodeVectorGraphPayload'
  | 'decodeVectorIndexParts'
  | 'detectRuntime'
  | 'emitEngineEvent'
  | 'emitSyncChange'
  | 'encodeDocument'
  | 'engineVersionParts'
  | 'extractVectorFieldsFromSchema'
  | 'flattenSchema'
  | 'fnv1a'
  | 'generateId'
  | 'getLanguage'
  | 'getNestedValue'
  | 'graphPartKey'
  | 'graphPartsOfEarlierPayload'
  | 'hasNrslMagic'
  | 'historyFileOf'
  | 'historyFilesOf'
  | 'holdSyncEpochChange'
  | 'insertDocumentVectors'
  | 'invalidManifest'
  | 'isCompositePartition'
  | 'isDead'
  | 'isId'
  | 'isQuantizationMode'
  | 'isRecord'
  | 'isSequenceNumber'
  | 'isStorageMode'
  | 'isSyncEpoch'
  | 'isUint32'
  | 'listHistoryFolder'
  | 'loadSchemaCodeFor'
  | 'manifestFileRefs'
  | 'manifestKey'
  | 'manifestReferencedKeys'
  | 'mergeDocFrequencies'
>

export let ANALYSIS_CHANGE_MEMBERS: Engine1Names['ANALYSIS_CHANGE_MEMBERS']
export let ErrorCodes: Engine1Names['ErrorCodes']
export let INDEX_NAME_PATTERN: Engine1Names['INDEX_NAME_PATTERN']
export let NarsilError: Engine1Names['NarsilError']
export type NarsilError = InstanceType<Engine1Names['NarsilError']>
export let SegmentRefusal: Engine1Names['SegmentRefusal']
export type SegmentRefusal = InstanceType<Engine1Names['SegmentRefusal']>
export let TermLookup: Engine1Names['TermLookup']
export type TermLookup = InstanceType<Engine1Names['TermLookup']>
export let VALID_HNSW_METRICS: Engine1Names['VALID_HNSW_METRICS']
export let VECTOR_FILE_MAX_VECTORS: Engine1Names['VECTOR_FILE_MAX_VECTORS']
export let VECTOR_PATTERN: Engine1Names['VECTOR_PATTERN']
export let arrayPositionsAreStale: Engine1Names['arrayPositionsAreStale']
export let assembleGraphParts: Engine1Names['assembleGraphParts']
export let assemblePagedFrozenSegment: Engine1Names['assemblePagedFrozenSegment']
export let attachedRuntimeOf: Engine1Names['attachedRuntimeOf']
export let buildPartialWordTableFrom: Engine1Names['buildPartialWordTableFrom']
export let bytesToVectors: Engine1Names['bytesToVectors']
export let checksumOfChunks: Engine1Names['checksumOfChunks']
export let chunksOf: Engine1Names['chunksOf']
export let compareCodePoints: Engine1Names['compareCodePoints']
export let compareScores: Engine1Names['compareScores']
export let configUnderAnalysis: Engine1Names['configUnderAnalysis']
export let configurationPayloadOf: Engine1Names['configurationPayloadOf']
export let countDead: Engine1Names['countDead']
export let countWrite: Engine1Names['countWrite']
export let crc32: Engine1Names['crc32']
export let crc32Final: Engine1Names['crc32Final']
export let crc32Init: Engine1Names['crc32Init']
export let crc32Update: Engine1Names['crc32Update']
export let createByteReader: Engine1Names['createByteReader']
export let createCompositePartition: Engine1Names['createCompositePartition']
export let createFrozenSegment: Engine1Names['createFrozenSegment']
export let createPartitionIndex: Engine1Names['createPartitionIndex']
export let createPartitionManager: Engine1Names['createPartitionManager']
export let createPartitionRouter: Engine1Names['createPartitionRouter']
export let createPublicationGate: Engine1Names['createPublicationGate']
export let deadBytesFor: Engine1Names['deadBytesFor']
export let decode: Engine1Names['decode']
export let decodeIndexConfiguration: Engine1Names['decodeIndexConfiguration']
export let decodeMulti: Engine1Names['decodeMulti']
export let decodeSegmentManifest: Engine1Names['decodeSegmentManifest']
export let decodeSurfaceTable: Engine1Names['decodeSurfaceTable']
export let decodeVectorFilePayload: Engine1Names['decodeVectorFilePayload']
export let decodeVectorGraphPartPayload: Engine1Names['decodeVectorGraphPartPayload']
export let decodeVectorGraphPayload: Engine1Names['decodeVectorGraphPayload']
export let decodeVectorIndexParts: Engine1Names['decodeVectorIndexParts']
export let detectRuntime: Engine1Names['detectRuntime']
export let emitEngineEvent: Engine1Names['emitEngineEvent']
export let emitSyncChange: Engine1Names['emitSyncChange']
export let encodeDocument: Engine1Names['encodeDocument']
export let engineVersionParts: Engine1Names['engineVersionParts']
export let extractVectorFieldsFromSchema: Engine1Names['extractVectorFieldsFromSchema']
export let flattenSchema: Engine1Names['flattenSchema']
export let fnv1a: Engine1Names['fnv1a']
export let generateId: Engine1Names['generateId']
export let getLanguage: Engine1Names['getLanguage']
export let getNestedValue: Engine1Names['getNestedValue']
export let graphPartKey: Engine1Names['graphPartKey']
export let graphPartsOfEarlierPayload: Engine1Names['graphPartsOfEarlierPayload']
export let hasNrslMagic: Engine1Names['hasNrslMagic']
export let historyFileOf: Engine1Names['historyFileOf']
export let historyFilesOf: Engine1Names['historyFilesOf']
export let holdSyncEpochChange: Engine1Names['holdSyncEpochChange']
export let insertDocumentVectors: Engine1Names['insertDocumentVectors']
export let invalidManifest: Engine1Names['invalidManifest']
export let isCompositePartition: Engine1Names['isCompositePartition']
export let isDead: Engine1Names['isDead']
export let isId: Engine1Names['isId']
export let isQuantizationMode: Engine1Names['isQuantizationMode']
export let isRecord: Engine1Names['isRecord']
export let isSequenceNumber: Engine1Names['isSequenceNumber']
export let isStorageMode: Engine1Names['isStorageMode']
export let isSyncEpoch: Engine1Names['isSyncEpoch']
export let isUint32: Engine1Names['isUint32']
export let listHistoryFolder: Engine1Names['listHistoryFolder']
export let loadSchemaCodeFor: Engine1Names['loadSchemaCodeFor']
export let manifestFileRefs: Engine1Names['manifestFileRefs']
export let manifestKey: Engine1Names['manifestKey']
export let manifestReferencedKeys: Engine1Names['manifestReferencedKeys']
export let mergeDocFrequencies: Engine1Names['mergeDocFrequencies']

export function bindEngine1Names(host: Engine1Names): void {
  ;({
    ANALYSIS_CHANGE_MEMBERS,
    ErrorCodes,
    INDEX_NAME_PATTERN,
    NarsilError,
    SegmentRefusal,
    TermLookup,
    VALID_HNSW_METRICS,
    VECTOR_FILE_MAX_VECTORS,
    VECTOR_PATTERN,
    arrayPositionsAreStale,
    assembleGraphParts,
    assemblePagedFrozenSegment,
    attachedRuntimeOf,
    buildPartialWordTableFrom,
    bytesToVectors,
    checksumOfChunks,
    chunksOf,
    compareCodePoints,
    compareScores,
    configUnderAnalysis,
    configurationPayloadOf,
    countDead,
    countWrite,
    crc32,
    crc32Final,
    crc32Init,
    crc32Update,
    createByteReader,
    createCompositePartition,
    createFrozenSegment,
    createPartitionIndex,
    createPartitionManager,
    createPartitionRouter,
    createPublicationGate,
    deadBytesFor,
    decode,
    decodeIndexConfiguration,
    decodeMulti,
    decodeSegmentManifest,
    decodeSurfaceTable,
    decodeVectorFilePayload,
    decodeVectorGraphPartPayload,
    decodeVectorGraphPayload,
    decodeVectorIndexParts,
    detectRuntime,
    emitEngineEvent,
    emitSyncChange,
    encodeDocument,
    engineVersionParts,
    extractVectorFieldsFromSchema,
    flattenSchema,
    fnv1a,
    generateId,
    getLanguage,
    getNestedValue,
    graphPartKey,
    graphPartsOfEarlierPayload,
    hasNrslMagic,
    historyFileOf,
    historyFilesOf,
    holdSyncEpochChange,
    insertDocumentVectors,
    invalidManifest,
    isCompositePartition,
    isDead,
    isId,
    isQuantizationMode,
    isRecord,
    isSequenceNumber,
    isStorageMode,
    isSyncEpoch,
    isUint32,
    listHistoryFolder,
    loadSchemaCodeFor,
    manifestFileRefs,
    manifestKey,
    manifestReferencedKeys,
    mergeDocFrequencies,
  } = host)
}
