import type { OptionalCodeHost } from '../../engine/optional-code-host'

type Engine2Names = Pick<
  OptionalCodeHost,
  | 'isSyncEpoch'
  | 'loadSchemaCodeFor'
  | 'mergeDocFrequencies'
  | 'mergeKeywordSources'
  | 'mergePartitionStats'
  | 'mergePostings'
  | 'messagePackUpperBoundBytes'
  | 'newSyncEpoch'
  | 'nodeThreadId'
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
  | 'readHeapStatistics'
  | 'readResidentMemory'
  | 'removeDocumentVectors'
  | 'removedSurfaceSpellings'
  | 'requireConfigurationWithinSizeLimit'
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

export let isSyncEpoch: Engine2Names['isSyncEpoch']
export let loadSchemaCodeFor: Engine2Names['loadSchemaCodeFor']
export let mergeDocFrequencies: Engine2Names['mergeDocFrequencies']
export let mergeKeywordSources: Engine2Names['mergeKeywordSources']
export let mergePartitionStats: Engine2Names['mergePartitionStats']
export let mergePostings: Engine2Names['mergePostings']
export let messagePackUpperBoundBytes: Engine2Names['messagePackUpperBoundBytes']
export let newSyncEpoch: Engine2Names['newSyncEpoch']
export let nodeThreadId: Engine2Names['nodeThreadId']
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
export let readHeapStatistics: Engine2Names['readHeapStatistics']
export let readResidentMemory: Engine2Names['readResidentMemory']
export let removeDocumentVectors: Engine2Names['removeDocumentVectors']
export let removedSurfaceSpellings: Engine2Names['removedSurfaceSpellings']
export let requireConfigurationWithinSizeLimit: Engine2Names['requireConfigurationWithinSizeLimit']
export let requireSearchActive: Engine2Names['requireSearchActive']
export let requireSurfaceFormsForPartialFields: Engine2Names['requireSurfaceFormsForPartialFields']
export let requireValidFieldTypes: Engine2Names['requireValidFieldTypes']
export let resolveIndexAnalysis: Engine2Names['resolveIndexAnalysis']
export let resolvePartialWordAnalysis: Engine2Names['resolvePartialWordAnalysis']
export let resolvePartitionInsertOptions: Engine2Names['resolvePartitionInsertOptions']
export let resolveWorkerEntry: Engine2Names['resolveWorkerEntry']
export let rulesOfStoredSynonyms: Engine2Names['rulesOfStoredSynonyms']
export let scanPostingBlocks: Engine2Names['scanPostingBlocks']
export let schemaFieldsOf: Engine2Names['schemaFieldsOf']
export let signalOfSearch: Engine2Names['signalOfSearch']
export let spawnNodeWorker: Engine2Names['spawnNodeWorker']
export let storedArrayPositionGap: Engine2Names['storedArrayPositionGap']
export let survivorDocumentsOf: Engine2Names['survivorDocumentsOf']
export let turnIsSpent: Engine2Names['turnIsSpent']
export let turnsAreBudgeted: Engine2Names['turnsAreBudgeted']
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
export let waitOutsideCountedWrite: Engine2Names['waitOutsideCountedWrite']
export let withOpenIndex: Engine2Names['withOpenIndex']
export let wrapFrozenTokenTable: Engine2Names['wrapFrozenTokenTable']
export let writePartitionDocument: Engine2Names['writePartitionDocument']
export let yieldToEventLoop: Engine2Names['yieldToEventLoop']
export let yieldTurn: Engine2Names['yieldTurn']

export function bindEngine2Names(host: Engine2Names): void {
  ;({
    isSyncEpoch,
    loadSchemaCodeFor,
    mergeDocFrequencies,
    mergeKeywordSources,
    mergePartitionStats,
    mergePostings,
    messagePackUpperBoundBytes,
    newSyncEpoch,
    nodeThreadId,
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
    readHeapStatistics,
    readResidentMemory,
    removeDocumentVectors,
    removedSurfaceSpellings,
    requireConfigurationWithinSizeLimit,
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
