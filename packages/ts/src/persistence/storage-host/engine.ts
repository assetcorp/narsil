import type { OptionalCodeHost } from '../../engine/optional-code-host'

type EngineNames = Pick<
  OptionalCodeHost,
  | 'ANALYSIS_CHANGE_MEMBERS'
  | 'ANALYSIS_HOLD_APPLY_INTERVAL_MS'
  | 'ARRAY_POSITION_GAP'
  | 'DEFAULT_BM25_B'
  | 'DEFAULT_BM25_K1'
  | 'DEFAULT_MAX_PARTITIONS'
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
  | 'MAX_M'
  | 'MAX_PARTITIONS'
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
  | 'createFrozenRemovals'
  | 'createFrozenSegment'
  | 'createPartitionIndex'
  | 'createPatternWorkMeter'
  | 'createPartitionManager'
  | 'createPartitionRouter'
  | 'createPublicationGate'
  | 'decodeSurfaceTable'
  | 'detectRuntime'
  | 'emitEngineEvent'
  | 'emitSyncChange'
  | 'validQueryFilter'
  | 'emptyPendingRegions'
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
  | 'isSyncEpoch'
  | 'loadGzip'
  | 'loadSchemaCodeFor'
  | 'mergeDocFrequencies'
  | 'mergeKeywordSources'
  | 'mergePartitionStats'
  | 'messagePackUpperBoundBytes'
  | 'newSyncEpoch'
  | 'nodeThreadId'
  | 'oversizedConfigurationPayloadOf'
  | 'parseVectorDimension'
  | 'partialFieldsOf'
  | 'partitionStateOf'
  | 'prepareConfiguredSynonyms'
  | 'prepareDocumentText'
  | 'prepareDocumentVectors'
  | 'prepareRemovalText'
  | 'prepareStoredSynonyms'
  | 'raiseEarlierReleaseGraphSetting'
  | 'readHeapStatistics'
  | 'readResidentMemory'
  | 'removeDocumentVectors'
  | 'removedSurfaceSpellings'
  | 'requireEncodedConfigurationWithinSizeLimit'
  | 'requireSearchActive'
  | 'requireSurfaceFormsForPartialFields'
  | 'requireValidFieldTypes'
  | 'resolveIndexAnalysis'
  | 'resolvePartialWordAnalysis'
  | 'resolvePartitionInsertOptions'
  | 'resolveWorkerEntry'
  | 'rulesOfStoredSynonyms'
  | 'scanPostingBlocks'
  | 'schemaFieldsOf'
  | 'signalOfSearch'
  | 'spawnNodeWorker'
  | 'storedArrayPositionGap'
  | 'survivorDocumentsOf'
  | 'turnIsSpent'
  | 'turnsAreBudgeted'
  | 'updateDocumentVectors'
  | 'validateDocument'
  | 'validateDocumentStrict'
  | 'validateEmbeddingConfig'
  | 'validatePatternValueLimit'
  | 'validateRequiredFieldsInSchema'
  | 'validateSchema'
  | 'validateTextStorage'
  | 'validateVectorPromotion'
  | 'validateVectorStorage'
  | 'waitOutsideCountedWrite'
  | 'withOpenIndex'
  | 'wrapFrozenTokenTable'
  | 'writePartitionDocument'
  | 'yieldToEventLoop'
  | 'yieldTurn'
>

export let ANALYSIS_CHANGE_MEMBERS: EngineNames['ANALYSIS_CHANGE_MEMBERS']
export let ANALYSIS_HOLD_APPLY_INTERVAL_MS: EngineNames['ANALYSIS_HOLD_APPLY_INTERVAL_MS']
export let ARRAY_POSITION_GAP: EngineNames['ARRAY_POSITION_GAP']
export let DEFAULT_BM25_B: EngineNames['DEFAULT_BM25_B']
export let DEFAULT_BM25_K1: EngineNames['DEFAULT_BM25_K1']
export let DEFAULT_MAX_PARTITIONS: EngineNames['DEFAULT_MAX_PARTITIONS']
export let EXPORT_CHUNK_BYTES: EngineNames['EXPORT_CHUNK_BYTES']
export let ErrorCodes: EngineNames['ErrorCodes']
export let FOREIGN_STATS_TTL_MS: EngineNames['FOREIGN_STATS_TTL_MS']
export let IMPORT_BATCH_DOCUMENTS: EngineNames['IMPORT_BATCH_DOCUMENTS']
export let INDEX_NAME_PATTERN: EngineNames['INDEX_NAME_PATTERN']
export let MAX_DOCUMENT_NESTING_DEPTH: EngineNames['MAX_DOCUMENT_NESTING_DEPTH']
export let MAX_EXPORT_LINE_BYTES: EngineNames['MAX_EXPORT_LINE_BYTES']
export let MAX_FILE_BYTES: EngineNames['MAX_FILE_BYTES']
export let MAX_IMPORT_REFUSALS_REPORTED: EngineNames['MAX_IMPORT_REFUSALS_REPORTED']
export let MAX_INDEX_NAME_LENGTH: EngineNames['MAX_INDEX_NAME_LENGTH']
export let MAX_LAYER_CAP: EngineNames['MAX_LAYER_CAP']
export let MAX_M: EngineNames['MAX_M']
export let MAX_PARTITIONS: EngineNames['MAX_PARTITIONS']
export let MIN_M: EngineNames['MIN_M']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>
export let STATISTICS_BROADCAST_INTERVAL_MS: EngineNames['STATISTICS_BROADCAST_INTERVAL_MS']
export let SegmentRefusal: EngineNames['SegmentRefusal']
export type SegmentRefusal = InstanceType<EngineNames['SegmentRefusal']>
export let TermLookup: EngineNames['TermLookup']
export type TermLookup = InstanceType<EngineNames['TermLookup']>
export let VALID_HNSW_METRICS: EngineNames['VALID_HNSW_METRICS']
export let VECTOR_PATTERN: EngineNames['VECTOR_PATTERN']
export let VERSION: EngineNames['VERSION']
export let arrayPositionsAreStale: EngineNames['arrayPositionsAreStale']
export let assemblePagedFrozenSegment: EngineNames['assemblePagedFrozenSegment']
export let buildPartialWordTableFrom: EngineNames['buildPartialWordTableFrom']
export let compareCodePoints: EngineNames['compareCodePoints']
export let compareScores: EngineNames['compareScores']
export let configurationPayloadOf: EngineNames['configurationPayloadOf']
export let countWrite: EngineNames['countWrite']
export let createCompositePartition: EngineNames['createCompositePartition']
export let createFrozenRemovals: EngineNames['createFrozenRemovals']
export let createFrozenSegment: EngineNames['createFrozenSegment']
export let createPartitionIndex: EngineNames['createPartitionIndex']
export let createPatternWorkMeter: EngineNames['createPatternWorkMeter']
export let validQueryFilter: EngineNames['validQueryFilter']
export let createPartitionManager: EngineNames['createPartitionManager']
export let createPartitionRouter: EngineNames['createPartitionRouter']
export let createPublicationGate: EngineNames['createPublicationGate']
export let decodeSurfaceTable: EngineNames['decodeSurfaceTable']
export let detectRuntime: EngineNames['detectRuntime']
export let emitEngineEvent: EngineNames['emitEngineEvent']
export let emitSyncChange: EngineNames['emitSyncChange']
export let emptyPendingRegions: EngineNames['emptyPendingRegions']
export let extractVectorFieldsFromSchema: EngineNames['extractVectorFieldsFromSchema']
export let flattenSchema: EngineNames['flattenSchema']
export let fnv1a: EngineNames['fnv1a']
export let generateId: EngineNames['generateId']
export let getLanguage: EngineNames['getLanguage']
export let getNestedValue: EngineNames['getNestedValue']
export let holdSyncEpochChange: EngineNames['holdSyncEpochChange']
export let insertDocumentVectors: EngineNames['insertDocumentVectors']
export let isCompositePartition: EngineNames['isCompositePartition']
export let isQuantizationMode: EngineNames['isQuantizationMode']
export let isStorageMode: EngineNames['isStorageMode']
export let isSyncEpoch: EngineNames['isSyncEpoch']
export let loadGzip: EngineNames['loadGzip']
export let loadSchemaCodeFor: EngineNames['loadSchemaCodeFor']
export let mergeDocFrequencies: EngineNames['mergeDocFrequencies']
export let mergeKeywordSources: EngineNames['mergeKeywordSources']
export let mergePartitionStats: EngineNames['mergePartitionStats']
export let messagePackUpperBoundBytes: EngineNames['messagePackUpperBoundBytes']
export let newSyncEpoch: EngineNames['newSyncEpoch']
export let nodeThreadId: EngineNames['nodeThreadId']
export let oversizedConfigurationPayloadOf: EngineNames['oversizedConfigurationPayloadOf']
export let parseVectorDimension: EngineNames['parseVectorDimension']
export let partialFieldsOf: EngineNames['partialFieldsOf']
export let partitionStateOf: EngineNames['partitionStateOf']
export let prepareConfiguredSynonyms: EngineNames['prepareConfiguredSynonyms']
export let prepareDocumentText: EngineNames['prepareDocumentText']
export let prepareDocumentVectors: EngineNames['prepareDocumentVectors']
export let prepareRemovalText: EngineNames['prepareRemovalText']
export let prepareStoredSynonyms: EngineNames['prepareStoredSynonyms']
export let raiseEarlierReleaseGraphSetting: EngineNames['raiseEarlierReleaseGraphSetting']
export let readHeapStatistics: EngineNames['readHeapStatistics']
export let readResidentMemory: EngineNames['readResidentMemory']
export let removeDocumentVectors: EngineNames['removeDocumentVectors']
export let removedSurfaceSpellings: EngineNames['removedSurfaceSpellings']
export let requireEncodedConfigurationWithinSizeLimit: EngineNames['requireEncodedConfigurationWithinSizeLimit']
export let requireSearchActive: EngineNames['requireSearchActive']
export let requireSurfaceFormsForPartialFields: EngineNames['requireSurfaceFormsForPartialFields']
export let requireValidFieldTypes: EngineNames['requireValidFieldTypes']
export let resolveIndexAnalysis: EngineNames['resolveIndexAnalysis']
export let resolvePartialWordAnalysis: EngineNames['resolvePartialWordAnalysis']
export let resolvePartitionInsertOptions: EngineNames['resolvePartitionInsertOptions']
export let resolveWorkerEntry: EngineNames['resolveWorkerEntry']
export let rulesOfStoredSynonyms: EngineNames['rulesOfStoredSynonyms']
export let scanPostingBlocks: EngineNames['scanPostingBlocks']
export let schemaFieldsOf: EngineNames['schemaFieldsOf']
export let signalOfSearch: EngineNames['signalOfSearch']
export let spawnNodeWorker: EngineNames['spawnNodeWorker']
export let storedArrayPositionGap: EngineNames['storedArrayPositionGap']
export let survivorDocumentsOf: EngineNames['survivorDocumentsOf']
export let turnIsSpent: EngineNames['turnIsSpent']
export let turnsAreBudgeted: EngineNames['turnsAreBudgeted']
export let updateDocumentVectors: EngineNames['updateDocumentVectors']
export let validateDocument: EngineNames['validateDocument']
export let validateDocumentStrict: EngineNames['validateDocumentStrict']
export let validateEmbeddingConfig: EngineNames['validateEmbeddingConfig']
export let validatePatternValueLimit: EngineNames['validatePatternValueLimit']
export let validateRequiredFieldsInSchema: EngineNames['validateRequiredFieldsInSchema']
export let validateSchema: EngineNames['validateSchema']
export let validateTextStorage: EngineNames['validateTextStorage']
export let validateVectorPromotion: EngineNames['validateVectorPromotion']
export let validateVectorStorage: EngineNames['validateVectorStorage']
export let waitOutsideCountedWrite: EngineNames['waitOutsideCountedWrite']
export let withOpenIndex: EngineNames['withOpenIndex']
export let wrapFrozenTokenTable: EngineNames['wrapFrozenTokenTable']
export let writePartitionDocument: EngineNames['writePartitionDocument']
export let yieldToEventLoop: EngineNames['yieldToEventLoop']
export let yieldTurn: EngineNames['yieldTurn']

export function bindEngineNames(host: EngineNames): void {
  ;({
    ANALYSIS_CHANGE_MEMBERS,
    ANALYSIS_HOLD_APPLY_INTERVAL_MS,
    ARRAY_POSITION_GAP,
    DEFAULT_BM25_B,
    DEFAULT_BM25_K1,
    DEFAULT_MAX_PARTITIONS,
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
    MAX_M,
    MAX_PARTITIONS,
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
    createFrozenRemovals,
    createFrozenSegment,
    createPartitionIndex,
    createPatternWorkMeter,
    validQueryFilter,
    createPartitionManager,
    createPartitionRouter,
    createPublicationGate,
    decodeSurfaceTable,
    detectRuntime,
    emitEngineEvent,
    emitSyncChange,
    emptyPendingRegions,
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
    isSyncEpoch,
    loadGzip,
    loadSchemaCodeFor,
    mergeDocFrequencies,
    mergeKeywordSources,
    mergePartitionStats,
    messagePackUpperBoundBytes,
    newSyncEpoch,
    nodeThreadId,
    oversizedConfigurationPayloadOf,
    parseVectorDimension,
    partialFieldsOf,
    partitionStateOf,
    prepareConfiguredSynonyms,
    prepareDocumentText,
    prepareDocumentVectors,
    prepareRemovalText,
    prepareStoredSynonyms,
    raiseEarlierReleaseGraphSetting,
    readHeapStatistics,
    readResidentMemory,
    removeDocumentVectors,
    removedSurfaceSpellings,
    requireEncodedConfigurationWithinSizeLimit,
    requireSearchActive,
    requireSurfaceFormsForPartialFields,
    requireValidFieldTypes,
    resolveIndexAnalysis,
    resolvePartialWordAnalysis,
    resolvePartitionInsertOptions,
    resolveWorkerEntry,
    rulesOfStoredSynonyms,
    scanPostingBlocks,
    schemaFieldsOf,
    signalOfSearch,
    spawnNodeWorker,
    storedArrayPositionGap,
    survivorDocumentsOf,
    turnIsSpent,
    turnsAreBudgeted,
    updateDocumentVectors,
    validateDocument,
    validateDocumentStrict,
    validateEmbeddingConfig,
    validatePatternValueLimit,
    validateRequiredFieldsInSchema,
    validateSchema,
    validateTextStorage,
    validateVectorPromotion,
    validateVectorStorage,
    waitOutsideCountedWrite,
    withOpenIndex,
    wrapFrozenTokenTable,
    writePartitionDocument,
    yieldToEventLoop,
    yieldTurn,
  } = host)
}
