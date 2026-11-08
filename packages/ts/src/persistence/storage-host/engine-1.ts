import type { OptionalCodeHost } from '../../engine/optional-code-host'

type Engine1Names = Pick<
  OptionalCodeHost,
  | 'ANALYSIS_CHANGE_MEMBERS'
  | 'ANALYSIS_HOLD_APPLY_INTERVAL_MS'
  | 'ARRAY_POSITION_GAP'
  | 'DEFAULT_BM25_B'
  | 'DEFAULT_BM25_K1'
  | 'EXPORT_CHUNK_BYTES'
  | 'ErrorCodes'
  | 'FOREIGN_STATS_TTL_MS'
  | 'IMPORT_BATCH_DOCUMENTS'
  | 'INDEX_NAME_PATTERN'
  | 'MAX_DOCUMENT_NESTING_DEPTH'
  | 'MAX_EXPORT_LINE_BYTES'
  | 'MAX_FILE_BYTES'
  | 'MAX_IMPORT_REFUSALS_REPORTED'
  | 'MAX_INDEX_NAME_LENGTH'
  | 'MAX_LAYER_CAP'
  | 'MIN_M'
  | 'NarsilError'
  | 'STATISTICS_BROADCAST_INTERVAL_MS'
  | 'SegmentRefusal'
  | 'TermLookup'
  | 'VALID_HNSW_METRICS'
  | 'VECTOR_PATTERN'
  | 'VERSION'
  | 'arrayPositionsAreStale'
  | 'assemblePagedFrozenSegment'
  | 'buildPartialWordTableFrom'
  | 'compareCodePoints'
  | 'compareScores'
  | 'configurationPayloadOf'
  | 'countWrite'
  | 'createCompositePartition'
  | 'createFrozenSegment'
  | 'createPartitionIndex'
  | 'createPartitionManager'
  | 'createPartitionRouter'
  | 'createPublicationGate'
  | 'decode'
  | 'decodeMulti'
  | 'decodeSurfaceTable'
  | 'detectRuntime'
  | 'emitEngineEvent'
  | 'emitSyncChange'
  | 'encode'
  | 'encodeDocument'
  | 'extractVectorFieldsFromSchema'
  | 'flattenSchema'
  | 'fnv1a'
  | 'generateId'
  | 'getLanguage'
  | 'getNestedValue'
  | 'holdSyncEpochChange'
  | 'insertDocumentVectors'
  | 'isCompositePartition'
  | 'isQuantizationMode'
  | 'isStorageMode'
>

export let ANALYSIS_CHANGE_MEMBERS: Engine1Names['ANALYSIS_CHANGE_MEMBERS']
export let ANALYSIS_HOLD_APPLY_INTERVAL_MS: Engine1Names['ANALYSIS_HOLD_APPLY_INTERVAL_MS']
export let ARRAY_POSITION_GAP: Engine1Names['ARRAY_POSITION_GAP']
export let DEFAULT_BM25_B: Engine1Names['DEFAULT_BM25_B']
export let DEFAULT_BM25_K1: Engine1Names['DEFAULT_BM25_K1']
export let EXPORT_CHUNK_BYTES: Engine1Names['EXPORT_CHUNK_BYTES']
export let ErrorCodes: Engine1Names['ErrorCodes']
export let FOREIGN_STATS_TTL_MS: Engine1Names['FOREIGN_STATS_TTL_MS']
export let IMPORT_BATCH_DOCUMENTS: Engine1Names['IMPORT_BATCH_DOCUMENTS']
export let INDEX_NAME_PATTERN: Engine1Names['INDEX_NAME_PATTERN']
export let MAX_DOCUMENT_NESTING_DEPTH: Engine1Names['MAX_DOCUMENT_NESTING_DEPTH']
export let MAX_EXPORT_LINE_BYTES: Engine1Names['MAX_EXPORT_LINE_BYTES']
export let MAX_FILE_BYTES: Engine1Names['MAX_FILE_BYTES']
export let MAX_IMPORT_REFUSALS_REPORTED: Engine1Names['MAX_IMPORT_REFUSALS_REPORTED']
export let MAX_INDEX_NAME_LENGTH: Engine1Names['MAX_INDEX_NAME_LENGTH']
export let MAX_LAYER_CAP: Engine1Names['MAX_LAYER_CAP']
export let MIN_M: Engine1Names['MIN_M']
export let NarsilError: Engine1Names['NarsilError']
export type NarsilError = InstanceType<Engine1Names['NarsilError']>
export let STATISTICS_BROADCAST_INTERVAL_MS: Engine1Names['STATISTICS_BROADCAST_INTERVAL_MS']
export let SegmentRefusal: Engine1Names['SegmentRefusal']
export type SegmentRefusal = InstanceType<Engine1Names['SegmentRefusal']>
export let TermLookup: Engine1Names['TermLookup']
export type TermLookup = InstanceType<Engine1Names['TermLookup']>
export let VALID_HNSW_METRICS: Engine1Names['VALID_HNSW_METRICS']
export let VECTOR_PATTERN: Engine1Names['VECTOR_PATTERN']
export let VERSION: Engine1Names['VERSION']
export let arrayPositionsAreStale: Engine1Names['arrayPositionsAreStale']
export let assemblePagedFrozenSegment: Engine1Names['assemblePagedFrozenSegment']
export let buildPartialWordTableFrom: Engine1Names['buildPartialWordTableFrom']
export let compareCodePoints: Engine1Names['compareCodePoints']
export let compareScores: Engine1Names['compareScores']
export let configurationPayloadOf: Engine1Names['configurationPayloadOf']
export let countWrite: Engine1Names['countWrite']
export let createCompositePartition: Engine1Names['createCompositePartition']
export let createFrozenSegment: Engine1Names['createFrozenSegment']
export let createPartitionIndex: Engine1Names['createPartitionIndex']
export let createPartitionManager: Engine1Names['createPartitionManager']
export let createPartitionRouter: Engine1Names['createPartitionRouter']
export let createPublicationGate: Engine1Names['createPublicationGate']
export let decode: Engine1Names['decode']
export let decodeMulti: Engine1Names['decodeMulti']
export let decodeSurfaceTable: Engine1Names['decodeSurfaceTable']
export let detectRuntime: Engine1Names['detectRuntime']
export let emitEngineEvent: Engine1Names['emitEngineEvent']
export let emitSyncChange: Engine1Names['emitSyncChange']
export let encode: Engine1Names['encode']
export let encodeDocument: Engine1Names['encodeDocument']
export let extractVectorFieldsFromSchema: Engine1Names['extractVectorFieldsFromSchema']
export let flattenSchema: Engine1Names['flattenSchema']
export let fnv1a: Engine1Names['fnv1a']
export let generateId: Engine1Names['generateId']
export let getLanguage: Engine1Names['getLanguage']
export let getNestedValue: Engine1Names['getNestedValue']
export let holdSyncEpochChange: Engine1Names['holdSyncEpochChange']
export let insertDocumentVectors: Engine1Names['insertDocumentVectors']
export let isCompositePartition: Engine1Names['isCompositePartition']
export let isQuantizationMode: Engine1Names['isQuantizationMode']
export let isStorageMode: Engine1Names['isStorageMode']

export function bindEngine1Names(host: Engine1Names): void {
  ;({
    ANALYSIS_CHANGE_MEMBERS,
    ANALYSIS_HOLD_APPLY_INTERVAL_MS,
    ARRAY_POSITION_GAP,
    DEFAULT_BM25_B,
    DEFAULT_BM25_K1,
    EXPORT_CHUNK_BYTES,
    ErrorCodes,
    FOREIGN_STATS_TTL_MS,
    IMPORT_BATCH_DOCUMENTS,
    INDEX_NAME_PATTERN,
    MAX_DOCUMENT_NESTING_DEPTH,
    MAX_EXPORT_LINE_BYTES,
    MAX_FILE_BYTES,
    MAX_IMPORT_REFUSALS_REPORTED,
    MAX_INDEX_NAME_LENGTH,
    MAX_LAYER_CAP,
    MIN_M,
    NarsilError,
    STATISTICS_BROADCAST_INTERVAL_MS,
    SegmentRefusal,
    TermLookup,
    VALID_HNSW_METRICS,
    VECTOR_PATTERN,
    VERSION,
    arrayPositionsAreStale,
    assemblePagedFrozenSegment,
    buildPartialWordTableFrom,
    compareCodePoints,
    compareScores,
    configurationPayloadOf,
    countWrite,
    createCompositePartition,
    createFrozenSegment,
    createPartitionIndex,
    createPartitionManager,
    createPartitionRouter,
    createPublicationGate,
    decode,
    decodeMulti,
    decodeSurfaceTable,
    detectRuntime,
    emitEngineEvent,
    emitSyncChange,
    encode,
    encodeDocument,
    extractVectorFieldsFromSchema,
    flattenSchema,
    fnv1a,
    generateId,
    getLanguage,
    getNestedValue,
    holdSyncEpochChange,
    insertDocumentVectors,
    isCompositePartition,
    isQuantizationMode,
    isStorageMode,
  } = host)
}
