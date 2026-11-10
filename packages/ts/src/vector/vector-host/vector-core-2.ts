import type * as VectorCoreCode from '../core-leaf'

type VectorCore2Names = Pick<
  typeof VectorCoreCode,
  | 'coverOrdinal'
  | 'emptyFieldBeforeRestore'
  | 'ensureBlockSlots'
  | 'euclideanDistance'
  | 'fieldHandlesOf'
  | 'filterForOptions'
  | 'fixedView'
  | 'graphNeedsRebuild'
  | 'growBufferTo'
  | 'grownByteLength'
  | 'handOverBuildTurns'
  | 'holdAdmission'
  | 'holdWritesAndBackgroundWork'
  | 'insertNode'
  | 'isDead'
  | 'liveOrdinals'
  | 'liveSize'
  | 'magnitude'
  | 'mayFree'
  | 'meanOfCentroidSums'
  | 'nativeMetricCode'
  | 'nativeScoresOf'
  | 'nativeStoreFor'
  | 'nativeStoreScratchBytes'
  | 'nextSequence'
  | 'noBuildHistory'
  | 'nodeCountOf'
  | 'noteFallback'
  | 'oldestHeldPin'
  | 'openGraphState'
  | 'openSharedQuantizer'
  | 'openVectorBlock'
  | 'ordinalFilterForSubsets'
  | 'ordinalFilterHas'
  | 'ordinalFilterValues'
  | 'osqBitsOf'
  | 'planCheckpoint'
  | 'publishSequence'
  | 'recalibrateFromStore'
  | 'recordCheckpoint'
  | 'releaseLocksHeldBy'
  | 'releasePinsHeldBy'
  | 'releaseReplacedVectors'
  | 'requireBytesWithinLimit'
  | 'requireWholeNeighbourLists'
  | 'resetStoreHeader'
  | 'retiredAtOf'
  | 'searchOrdinals'
  | 'sequenceWritesOf'
  | 'sharedMemoryAvailable'
  | 'sharedVectorStoreBytes'
  | 'shuffleInPlace'
  | 'shuffleStep'
  | 'signatureOf'
  | 'slotByteOffset'
  | 'squaredLengthsOfCentroidSums'
  | 'stampBorn'
  | 'stampRetired'
  | 'storePinsOf'
  | 'threadedNativeCore'
  | 'threadsHoldCurrentLayout'
  | 'toDistance'
  | 'toScore'
  | 'tombstoneCountOf'
  | 'topLayerInParts'
  | 'turnsAreBudgeted'
  | 'unplacedChunkCount'
  | 'withNativeThreadSlot'
  | 'withTransientAdmission'
  | 'writeSequenceOf'
  | 'writeSequenceWords'
  | 'yieldBackgroundTurn'
  | 'yieldBuildTurn'
>

export let coverOrdinal: VectorCore2Names['coverOrdinal']
export let emptyFieldBeforeRestore: VectorCore2Names['emptyFieldBeforeRestore']
export let ensureBlockSlots: VectorCore2Names['ensureBlockSlots']
export let euclideanDistance: VectorCore2Names['euclideanDistance']
export let fieldHandlesOf: VectorCore2Names['fieldHandlesOf']
export let filterForOptions: VectorCore2Names['filterForOptions']
export let fixedView: VectorCore2Names['fixedView']
export let graphNeedsRebuild: VectorCore2Names['graphNeedsRebuild']
export let growBufferTo: VectorCore2Names['growBufferTo']
export let grownByteLength: VectorCore2Names['grownByteLength']
export let handOverBuildTurns: VectorCore2Names['handOverBuildTurns']
export let holdAdmission: VectorCore2Names['holdAdmission']
export let holdWritesAndBackgroundWork: VectorCore2Names['holdWritesAndBackgroundWork']
export let insertNode: VectorCore2Names['insertNode']
export let isDead: VectorCore2Names['isDead']
export let liveOrdinals: VectorCore2Names['liveOrdinals']
export let liveSize: VectorCore2Names['liveSize']
export let magnitude: VectorCore2Names['magnitude']
export let mayFree: VectorCore2Names['mayFree']
export let meanOfCentroidSums: VectorCore2Names['meanOfCentroidSums']
export let nativeMetricCode: VectorCore2Names['nativeMetricCode']
export let nativeScoresOf: VectorCore2Names['nativeScoresOf']
export let nativeStoreFor: VectorCore2Names['nativeStoreFor']
export let nativeStoreScratchBytes: VectorCore2Names['nativeStoreScratchBytes']
export let nextSequence: VectorCore2Names['nextSequence']
export let noBuildHistory: VectorCore2Names['noBuildHistory']
export let nodeCountOf: VectorCore2Names['nodeCountOf']
export let noteFallback: VectorCore2Names['noteFallback']
export let oldestHeldPin: VectorCore2Names['oldestHeldPin']
export let openGraphState: VectorCore2Names['openGraphState']
export let openSharedQuantizer: VectorCore2Names['openSharedQuantizer']
export let openVectorBlock: VectorCore2Names['openVectorBlock']
export let ordinalFilterForSubsets: VectorCore2Names['ordinalFilterForSubsets']
export let ordinalFilterHas: VectorCore2Names['ordinalFilterHas']
export let ordinalFilterValues: VectorCore2Names['ordinalFilterValues']
export let osqBitsOf: VectorCore2Names['osqBitsOf']
export let planCheckpoint: VectorCore2Names['planCheckpoint']
export let publishSequence: VectorCore2Names['publishSequence']
export let recalibrateFromStore: VectorCore2Names['recalibrateFromStore']
export let recordCheckpoint: VectorCore2Names['recordCheckpoint']
export let releaseLocksHeldBy: VectorCore2Names['releaseLocksHeldBy']
export let releasePinsHeldBy: VectorCore2Names['releasePinsHeldBy']
export let releaseReplacedVectors: VectorCore2Names['releaseReplacedVectors']
export let requireBytesWithinLimit: VectorCore2Names['requireBytesWithinLimit']
export let requireWholeNeighbourLists: VectorCore2Names['requireWholeNeighbourLists']
export let resetStoreHeader: VectorCore2Names['resetStoreHeader']
export let retiredAtOf: VectorCore2Names['retiredAtOf']
export let searchOrdinals: VectorCore2Names['searchOrdinals']
export let sequenceWritesOf: VectorCore2Names['sequenceWritesOf']
export let sharedMemoryAvailable: VectorCore2Names['sharedMemoryAvailable']
export let sharedVectorStoreBytes: VectorCore2Names['sharedVectorStoreBytes']
export let shuffleInPlace: VectorCore2Names['shuffleInPlace']
export let shuffleStep: VectorCore2Names['shuffleStep']
export let signatureOf: VectorCore2Names['signatureOf']
export let slotByteOffset: VectorCore2Names['slotByteOffset']
export let squaredLengthsOfCentroidSums: VectorCore2Names['squaredLengthsOfCentroidSums']
export let stampBorn: VectorCore2Names['stampBorn']
export let stampRetired: VectorCore2Names['stampRetired']
export let storePinsOf: VectorCore2Names['storePinsOf']
export let threadedNativeCore: VectorCore2Names['threadedNativeCore']
export let threadsHoldCurrentLayout: VectorCore2Names['threadsHoldCurrentLayout']
export let toDistance: VectorCore2Names['toDistance']
export let toScore: VectorCore2Names['toScore']
export let tombstoneCountOf: VectorCore2Names['tombstoneCountOf']
export let topLayerInParts: VectorCore2Names['topLayerInParts']
export let turnsAreBudgeted: VectorCore2Names['turnsAreBudgeted']
export let unplacedChunkCount: VectorCore2Names['unplacedChunkCount']
export let withNativeThreadSlot: VectorCore2Names['withNativeThreadSlot']
export let withTransientAdmission: VectorCore2Names['withTransientAdmission']
export let writeSequenceOf: VectorCore2Names['writeSequenceOf']
export let writeSequenceWords: VectorCore2Names['writeSequenceWords']
export let yieldBackgroundTurn: VectorCore2Names['yieldBackgroundTurn']
export let yieldBuildTurn: VectorCore2Names['yieldBuildTurn']

export function bindVectorCore2Names(vectorCore: VectorCore2Names): void {
  ;({
    coverOrdinal,
    emptyFieldBeforeRestore,
    ensureBlockSlots,
    euclideanDistance,
    fieldHandlesOf,
    filterForOptions,
    fixedView,
    graphNeedsRebuild,
    growBufferTo,
    grownByteLength,
    handOverBuildTurns,
    holdAdmission,
    holdWritesAndBackgroundWork,
    insertNode,
    isDead,
    liveOrdinals,
    liveSize,
    magnitude,
    mayFree,
    meanOfCentroidSums,
    nativeMetricCode,
    nativeScoresOf,
    nativeStoreFor,
    nativeStoreScratchBytes,
    nextSequence,
    noBuildHistory,
    nodeCountOf,
    noteFallback,
    oldestHeldPin,
    openGraphState,
    openSharedQuantizer,
    openVectorBlock,
    ordinalFilterForSubsets,
    ordinalFilterHas,
    ordinalFilterValues,
    osqBitsOf,
    planCheckpoint,
    publishSequence,
    recalibrateFromStore,
    recordCheckpoint,
    releaseLocksHeldBy,
    releasePinsHeldBy,
    releaseReplacedVectors,
    requireBytesWithinLimit,
    requireWholeNeighbourLists,
    resetStoreHeader,
    retiredAtOf,
    searchOrdinals,
    sequenceWritesOf,
    sharedMemoryAvailable,
    sharedVectorStoreBytes,
    shuffleInPlace,
    shuffleStep,
    signatureOf,
    slotByteOffset,
    squaredLengthsOfCentroidSums,
    stampBorn,
    stampRetired,
    storePinsOf,
    threadedNativeCore,
    threadsHoldCurrentLayout,
    toDistance,
    toScore,
    tombstoneCountOf,
    topLayerInParts,
    turnsAreBudgeted,
    unplacedChunkCount,
    withNativeThreadSlot,
    withTransientAdmission,
    writeSequenceOf,
    writeSequenceWords,
    yieldBackgroundTurn,
    yieldBuildTurn,
  } = vectorCore)
}
