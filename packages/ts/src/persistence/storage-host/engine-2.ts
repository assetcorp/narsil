import type { OptionalCodeHost } from '../../engine/optional-code-host'

type Engine2Names = Pick<
  OptionalCodeHost,
  | 'mergeKeywordSources'
  | 'mergePartitionStats'
  | 'mergePostings'
  | 'messagePackUpperBoundBytes'
  | 'newSyncEpoch'
  | 'nodeThreadId'
  | 'oneSyncChangeAtATime'
  | 'openChecksummedEnvelope'
  | 'osqRecordBytes'
  | 'packChecksummedEnvelope'
  | 'packEnvelopeWithChecksum'
  | 'parseVectorDimension'
  | 'partialFieldsOf'
  | 'partitionStateOf'
  | 'prepareConfiguredSynonyms'
  | 'prepareDocumentText'
  | 'prepareDocumentVectors'
  | 'prepareFrozenPublication'
  | 'prepareRemovalText'
  | 'prepareStoredSynonyms'
  | 'raiseEarlierReleaseGraphSetting'
  | 'readHeader'
  | 'readHeapStatistics'
  | 'readResidentMemory'
  | 'readSnapshotArchive'
  | 'readTrailer'
  | 'removeDocumentVectors'
  | 'removedSurfaceSpellings'
  | 'requireConfigurationShape'
  | 'requireConfigurationWithinSizeLimit'
  | 'requireSearchActive'
  | 'requireSurfaceFormsForPartialFields'
  | 'requireValidFieldTypes'
  | 'requireWithinFileLimit'
  | 'resolveIndexAnalysis'
  | 'resolvePartialWordAnalysis'
  | 'resolvePartitionInsertOptions'
  | 'resolveWorkerEntry'
  | 'rulesOfStoredSynonyms'
  | 'scanPostingBlocks'
  | 'schemaFieldsOf'
  | 'segmentKey'
  | 'segmentsPrefix'
  | 'sha256'
  | 'signalOfSearch'
  | 'snapshotBundleKey'
  | 'spawnNodeWorker'
  | 'stageQueryLevels'
  | 'storedArrayPositionGap'
  | 'storedStateFromWire'
  | 'storedStateOf'
  | 'storedStateToWire'
  | 'survivorDocumentsOf'
  | 'tarEnd'
  | 'tarEntryHeaders'
  | 'tarPadding'
  | 'targetOfPending'
  | 'turnIsSpent'
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
  | 'vectorFileKey'
  | 'vectorsToBytes'
  | 'waitOutsideCountedWrite'
  | 'withOpenIndex'
  | 'wrapFrozenTokenTable'
  | 'writeHeader'
  | 'writePartitionDocument'
  | 'yieldToEventLoop'
  | 'yieldTurn'
>

export let mergeKeywordSources: Engine2Names['mergeKeywordSources']
export let mergePartitionStats: Engine2Names['mergePartitionStats']
export let mergePostings: Engine2Names['mergePostings']
export let messagePackUpperBoundBytes: Engine2Names['messagePackUpperBoundBytes']
export let newSyncEpoch: Engine2Names['newSyncEpoch']
export let nodeThreadId: Engine2Names['nodeThreadId']
export let oneSyncChangeAtATime: Engine2Names['oneSyncChangeAtATime']
export let openChecksummedEnvelope: Engine2Names['openChecksummedEnvelope']
export let osqRecordBytes: Engine2Names['osqRecordBytes']
export let packChecksummedEnvelope: Engine2Names['packChecksummedEnvelope']
export let packEnvelopeWithChecksum: Engine2Names['packEnvelopeWithChecksum']
export let parseVectorDimension: Engine2Names['parseVectorDimension']
export let partialFieldsOf: Engine2Names['partialFieldsOf']
export let partitionStateOf: Engine2Names['partitionStateOf']
export let prepareConfiguredSynonyms: Engine2Names['prepareConfiguredSynonyms']
export let prepareDocumentText: Engine2Names['prepareDocumentText']
export let prepareDocumentVectors: Engine2Names['prepareDocumentVectors']
export let prepareFrozenPublication: Engine2Names['prepareFrozenPublication']
export let prepareRemovalText: Engine2Names['prepareRemovalText']
export let prepareStoredSynonyms: Engine2Names['prepareStoredSynonyms']
export let raiseEarlierReleaseGraphSetting: Engine2Names['raiseEarlierReleaseGraphSetting']
export let readHeader: Engine2Names['readHeader']
export let readHeapStatistics: Engine2Names['readHeapStatistics']
export let readResidentMemory: Engine2Names['readResidentMemory']
export let readSnapshotArchive: Engine2Names['readSnapshotArchive']
export let readTrailer: Engine2Names['readTrailer']
export let removeDocumentVectors: Engine2Names['removeDocumentVectors']
export let removedSurfaceSpellings: Engine2Names['removedSurfaceSpellings']
export let requireConfigurationShape: Engine2Names['requireConfigurationShape']
export let requireConfigurationWithinSizeLimit: Engine2Names['requireConfigurationWithinSizeLimit']
export let requireSearchActive: Engine2Names['requireSearchActive']
export let requireSurfaceFormsForPartialFields: Engine2Names['requireSurfaceFormsForPartialFields']
export let requireValidFieldTypes: Engine2Names['requireValidFieldTypes']
export let requireWithinFileLimit: Engine2Names['requireWithinFileLimit']
export let resolveIndexAnalysis: Engine2Names['resolveIndexAnalysis']
export let resolvePartialWordAnalysis: Engine2Names['resolvePartialWordAnalysis']
export let resolvePartitionInsertOptions: Engine2Names['resolvePartitionInsertOptions']
export let resolveWorkerEntry: Engine2Names['resolveWorkerEntry']
export let rulesOfStoredSynonyms: Engine2Names['rulesOfStoredSynonyms']
export let scanPostingBlocks: Engine2Names['scanPostingBlocks']
export let schemaFieldsOf: Engine2Names['schemaFieldsOf']
export let segmentKey: Engine2Names['segmentKey']
export let segmentsPrefix: Engine2Names['segmentsPrefix']
export let sha256: Engine2Names['sha256']
export let signalOfSearch: Engine2Names['signalOfSearch']
export let snapshotBundleKey: Engine2Names['snapshotBundleKey']
export let spawnNodeWorker: Engine2Names['spawnNodeWorker']
export let stageQueryLevels: Engine2Names['stageQueryLevels']
export let storedArrayPositionGap: Engine2Names['storedArrayPositionGap']
export let storedStateFromWire: Engine2Names['storedStateFromWire']
export let storedStateOf: Engine2Names['storedStateOf']
export let storedStateToWire: Engine2Names['storedStateToWire']
export let survivorDocumentsOf: Engine2Names['survivorDocumentsOf']
export let tarEnd: Engine2Names['tarEnd']
export let tarEntryHeaders: Engine2Names['tarEntryHeaders']
export let tarPadding: Engine2Names['tarPadding']
export let targetOfPending: Engine2Names['targetOfPending']
export let turnIsSpent: Engine2Names['turnIsSpent']
export let updateDocumentVectors: Engine2Names['updateDocumentVectors']
export let validateDocument: Engine2Names['validateDocument']
export let validateDocumentStrict: Engine2Names['validateDocumentStrict']
export let validateEmbeddingConfig: Engine2Names['validateEmbeddingConfig']
export let validatePatternValueLimit: Engine2Names['validatePatternValueLimit']
export let validateRequiredFieldsInSchema: Engine2Names['validateRequiredFieldsInSchema']
export let validateSchema: Engine2Names['validateSchema']
export let validateTextStorage: Engine2Names['validateTextStorage']
export let validateVectorPromotion: Engine2Names['validateVectorPromotion']
export let validateVectorStorage: Engine2Names['validateVectorStorage']
export let vectorFileKey: Engine2Names['vectorFileKey']
export let vectorsToBytes: Engine2Names['vectorsToBytes']
export let waitOutsideCountedWrite: Engine2Names['waitOutsideCountedWrite']
export let withOpenIndex: Engine2Names['withOpenIndex']
export let wrapFrozenTokenTable: Engine2Names['wrapFrozenTokenTable']
export let writeHeader: Engine2Names['writeHeader']
export let writePartitionDocument: Engine2Names['writePartitionDocument']
export let yieldToEventLoop: Engine2Names['yieldToEventLoop']
export let yieldTurn: Engine2Names['yieldTurn']

export function bindEngine2Names(host: Engine2Names): void {
  ;({
    mergeKeywordSources,
    mergePartitionStats,
    mergePostings,
    messagePackUpperBoundBytes,
    newSyncEpoch,
    nodeThreadId,
    oneSyncChangeAtATime,
    openChecksummedEnvelope,
    osqRecordBytes,
    packChecksummedEnvelope,
    packEnvelopeWithChecksum,
    parseVectorDimension,
    partialFieldsOf,
    partitionStateOf,
    prepareConfiguredSynonyms,
    prepareDocumentText,
    prepareDocumentVectors,
    prepareFrozenPublication,
    prepareRemovalText,
    prepareStoredSynonyms,
    raiseEarlierReleaseGraphSetting,
    readHeader,
    readHeapStatistics,
    readResidentMemory,
    readSnapshotArchive,
    readTrailer,
    removeDocumentVectors,
    removedSurfaceSpellings,
    requireConfigurationShape,
    requireConfigurationWithinSizeLimit,
    requireSearchActive,
    requireSurfaceFormsForPartialFields,
    requireValidFieldTypes,
    requireWithinFileLimit,
    resolveIndexAnalysis,
    resolvePartialWordAnalysis,
    resolvePartitionInsertOptions,
    resolveWorkerEntry,
    rulesOfStoredSynonyms,
    scanPostingBlocks,
    schemaFieldsOf,
    segmentKey,
    segmentsPrefix,
    sha256,
    signalOfSearch,
    snapshotBundleKey,
    spawnNodeWorker,
    stageQueryLevels,
    storedArrayPositionGap,
    storedStateFromWire,
    storedStateOf,
    storedStateToWire,
    survivorDocumentsOf,
    tarEnd,
    tarEntryHeaders,
    tarPadding,
    targetOfPending,
    turnIsSpent,
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
    vectorFileKey,
    vectorsToBytes,
    waitOutsideCountedWrite,
    withOpenIndex,
    wrapFrozenTokenTable,
    writeHeader,
    writePartitionDocument,
    yieldToEventLoop,
    yieldTurn,
  } = host)
}
