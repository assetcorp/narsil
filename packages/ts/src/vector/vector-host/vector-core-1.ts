import type * as VectorCoreCode from '../core-leaf'

type VectorCore1Names = Pick<
  typeof VectorCoreCode,
  | 'BUILD_CHUNK_SIZE'
  | 'BUILD_RETRY_FIRST_DELAY_MS'
  | 'BUILD_RETRY_MAX_DELAY_MS'
  | 'BUILD_STEPS_BETWEEN_CLOCK_CHECKS'
  | 'DEFAULT_FILTER_THRESHOLD'
  | 'DEFAULT_PROMOTION_THRESHOLD'
  | 'DEFAULT_VECTOR_METRIC'
  | 'DISK_ADOPTION_YIELD_INTERVAL'
  | 'DRIFT_CHECK_GROWTH_FACTOR'
  | 'ESTIMATED_MS_PER_TOMBSTONE'
  | 'ESTIMATED_MS_PER_VECTOR_REBUILD'
  | 'GRAPH_RETIRED'
  | 'IN_MEMORY'
  | 'MIN_OVERSAMPLE'
  | 'NATIVE_OK'
  | 'NOTHING_STAGED'
  | 'NO_LIVE_VECTOR_AT_POSITION'
  | 'QUERY_STAGED'
  | 'RECALIBRATION_CHUNK_VECTORS'
  | 'RECALIBRATION_DRIFT_RATIO'
  | 'REFUSAL_COLLECTION_MIN_INTERVAL_MS'
  | 'REFUSAL_COLLECTION_TIME_MULTIPLE'
  | 'REFUSAL_YOUNG_COLLECTION_MIN_INTERVAL_MS'
  | 'SEARCH_ATTEMPTS_BEFORE_HOLDING_WRITES'
  | 'SEARCH_REFILL_RESERVE'
  | 'SEARCH_SCAN_CHUNK_VECTORS'
  | 'SHUFFLED_REBUILD_MEMORY_RETRY_MS'
  | 'STORE_BLOCK_COUNT'
  | 'STORE_CALIBRATED'
  | 'STORE_CALIBRATION_GENERATION'
  | 'STORE_CODE_BLOCK_COUNT'
  | 'STORE_CODE_COUNT'
  | 'STORE_DOC_ID_BYTES'
  | 'STORE_LIVE_COUNT'
  | 'STORE_ORDINAL_LAYOUT_GENERATION'
  | 'STORE_RELEASED_VECTORS_TO_DISK'
  | 'STORE_REMOVED_COUNT'
  | 'STORE_SLOTS'
  | 'STORE_UNPLACED_COUNT'
  | 'UI_THREAD_BACKGROUND_SLICE_DURING_WRITES_MS'
  | 'UI_THREAD_HOP_BEFORE_TURN_WITHIN_MS'
  | 'UI_THREAD_TURN_BUDGET_MS'
  | 'VECTOR_MEMORY_LIMITS'
  | 'VECTOR_WORKER_COPIES_ALLOWED'
  | 'WORKER_COPY_MIN_VECTORS'
  | 'addToOrdinalFilter'
  | 'admissionAt'
  | 'adoptBackgroundScheduler'
  | 'adoptGraph'
  | 'adoptLoadedCalibration'
  | 'allLiveDocIds'
  | 'arenaFloat32Distance'
  | 'assignStorePartitions'
  | 'backgroundTurnIsSpent'
  | 'blocksGrowthBytes'
  | 'bytesToVectors'
  | 'centroidOfCentroidSums'
  | 'collectAndReturnPages'
  | 'collectYoungGeneration'
  | 'cosineSimilarityWithMagnitudes'
  | 'countOfCentroidSums'
  | 'createCentroidSums'
  | 'createHNSWIndex'
  | 'createOrdinalFilter'
  | 'createOsqQuantizer'
  | 'createSharedVectorStoreHandles'
  | 'createVectorBlock'
  | 'createVectorFileReader'
  | 'defaultQuantizationFor'
  | 'deserialize'
  | 'detachNativeStore'
  | 'dotProduct'
>

export let BUILD_CHUNK_SIZE: VectorCore1Names['BUILD_CHUNK_SIZE']
export let BUILD_RETRY_FIRST_DELAY_MS: VectorCore1Names['BUILD_RETRY_FIRST_DELAY_MS']
export let BUILD_RETRY_MAX_DELAY_MS: VectorCore1Names['BUILD_RETRY_MAX_DELAY_MS']
export let BUILD_STEPS_BETWEEN_CLOCK_CHECKS: VectorCore1Names['BUILD_STEPS_BETWEEN_CLOCK_CHECKS']
export let DEFAULT_FILTER_THRESHOLD: VectorCore1Names['DEFAULT_FILTER_THRESHOLD']
export let DEFAULT_PROMOTION_THRESHOLD: VectorCore1Names['DEFAULT_PROMOTION_THRESHOLD']
export let DEFAULT_VECTOR_METRIC: VectorCore1Names['DEFAULT_VECTOR_METRIC']
export let DISK_ADOPTION_YIELD_INTERVAL: VectorCore1Names['DISK_ADOPTION_YIELD_INTERVAL']
export let DRIFT_CHECK_GROWTH_FACTOR: VectorCore1Names['DRIFT_CHECK_GROWTH_FACTOR']
export let ESTIMATED_MS_PER_TOMBSTONE: VectorCore1Names['ESTIMATED_MS_PER_TOMBSTONE']
export let ESTIMATED_MS_PER_VECTOR_REBUILD: VectorCore1Names['ESTIMATED_MS_PER_VECTOR_REBUILD']
export let GRAPH_RETIRED: VectorCore1Names['GRAPH_RETIRED']
export let IN_MEMORY: VectorCore1Names['IN_MEMORY']
export let MIN_OVERSAMPLE: VectorCore1Names['MIN_OVERSAMPLE']
export let NATIVE_OK: VectorCore1Names['NATIVE_OK']
export let NOTHING_STAGED: VectorCore1Names['NOTHING_STAGED']
export let NO_LIVE_VECTOR_AT_POSITION: VectorCore1Names['NO_LIVE_VECTOR_AT_POSITION']
export let QUERY_STAGED: VectorCore1Names['QUERY_STAGED']
export let RECALIBRATION_CHUNK_VECTORS: VectorCore1Names['RECALIBRATION_CHUNK_VECTORS']
export let RECALIBRATION_DRIFT_RATIO: VectorCore1Names['RECALIBRATION_DRIFT_RATIO']
export let REFUSAL_COLLECTION_MIN_INTERVAL_MS: VectorCore1Names['REFUSAL_COLLECTION_MIN_INTERVAL_MS']
export let REFUSAL_COLLECTION_TIME_MULTIPLE: VectorCore1Names['REFUSAL_COLLECTION_TIME_MULTIPLE']
export let REFUSAL_YOUNG_COLLECTION_MIN_INTERVAL_MS: VectorCore1Names['REFUSAL_YOUNG_COLLECTION_MIN_INTERVAL_MS']
export let SEARCH_ATTEMPTS_BEFORE_HOLDING_WRITES: VectorCore1Names['SEARCH_ATTEMPTS_BEFORE_HOLDING_WRITES']
export let SEARCH_REFILL_RESERVE: VectorCore1Names['SEARCH_REFILL_RESERVE']
export let SEARCH_SCAN_CHUNK_VECTORS: VectorCore1Names['SEARCH_SCAN_CHUNK_VECTORS']
export let SHUFFLED_REBUILD_MEMORY_RETRY_MS: VectorCore1Names['SHUFFLED_REBUILD_MEMORY_RETRY_MS']
export let STORE_BLOCK_COUNT: VectorCore1Names['STORE_BLOCK_COUNT']
export let STORE_CALIBRATED: VectorCore1Names['STORE_CALIBRATED']
export let STORE_CALIBRATION_GENERATION: VectorCore1Names['STORE_CALIBRATION_GENERATION']
export let STORE_CODE_BLOCK_COUNT: VectorCore1Names['STORE_CODE_BLOCK_COUNT']
export let STORE_CODE_COUNT: VectorCore1Names['STORE_CODE_COUNT']
export let STORE_DOC_ID_BYTES: VectorCore1Names['STORE_DOC_ID_BYTES']
export let STORE_LIVE_COUNT: VectorCore1Names['STORE_LIVE_COUNT']
export let STORE_ORDINAL_LAYOUT_GENERATION: VectorCore1Names['STORE_ORDINAL_LAYOUT_GENERATION']
export let STORE_RELEASED_VECTORS_TO_DISK: VectorCore1Names['STORE_RELEASED_VECTORS_TO_DISK']
export let STORE_REMOVED_COUNT: VectorCore1Names['STORE_REMOVED_COUNT']
export let STORE_SLOTS: VectorCore1Names['STORE_SLOTS']
export let STORE_UNPLACED_COUNT: VectorCore1Names['STORE_UNPLACED_COUNT']
export let UI_THREAD_BACKGROUND_SLICE_DURING_WRITES_MS: VectorCore1Names['UI_THREAD_BACKGROUND_SLICE_DURING_WRITES_MS']
export let UI_THREAD_HOP_BEFORE_TURN_WITHIN_MS: VectorCore1Names['UI_THREAD_HOP_BEFORE_TURN_WITHIN_MS']
export let UI_THREAD_TURN_BUDGET_MS: VectorCore1Names['UI_THREAD_TURN_BUDGET_MS']
export let VECTOR_MEMORY_LIMITS: VectorCore1Names['VECTOR_MEMORY_LIMITS']
export let VECTOR_WORKER_COPIES_ALLOWED: VectorCore1Names['VECTOR_WORKER_COPIES_ALLOWED']
export let WORKER_COPY_MIN_VECTORS: VectorCore1Names['WORKER_COPY_MIN_VECTORS']
export let addToOrdinalFilter: VectorCore1Names['addToOrdinalFilter']
export let admissionAt: VectorCore1Names['admissionAt']
export let adoptBackgroundScheduler: VectorCore1Names['adoptBackgroundScheduler']
export let adoptGraph: VectorCore1Names['adoptGraph']
export let adoptLoadedCalibration: VectorCore1Names['adoptLoadedCalibration']
export let allLiveDocIds: VectorCore1Names['allLiveDocIds']
export let arenaFloat32Distance: VectorCore1Names['arenaFloat32Distance']
export let assignStorePartitions: VectorCore1Names['assignStorePartitions']
export let backgroundTurnIsSpent: VectorCore1Names['backgroundTurnIsSpent']
export let blocksGrowthBytes: VectorCore1Names['blocksGrowthBytes']
export let bytesToVectors: VectorCore1Names['bytesToVectors']
export let centroidOfCentroidSums: VectorCore1Names['centroidOfCentroidSums']
export let collectAndReturnPages: VectorCore1Names['collectAndReturnPages']
export let collectYoungGeneration: VectorCore1Names['collectYoungGeneration']
export let cosineSimilarityWithMagnitudes: VectorCore1Names['cosineSimilarityWithMagnitudes']
export let countOfCentroidSums: VectorCore1Names['countOfCentroidSums']
export let createCentroidSums: VectorCore1Names['createCentroidSums']
export let createHNSWIndex: VectorCore1Names['createHNSWIndex']
export let createOrdinalFilter: VectorCore1Names['createOrdinalFilter']
export let createOsqQuantizer: VectorCore1Names['createOsqQuantizer']
export let createSharedVectorStoreHandles: VectorCore1Names['createSharedVectorStoreHandles']
export let createVectorBlock: VectorCore1Names['createVectorBlock']
export let createVectorFileReader: VectorCore1Names['createVectorFileReader']
export let defaultQuantizationFor: VectorCore1Names['defaultQuantizationFor']
export let deserialize: VectorCore1Names['deserialize']
export let detachNativeStore: VectorCore1Names['detachNativeStore']
export let dotProduct: VectorCore1Names['dotProduct']

export function bindVectorCore1Names(vectorCore: VectorCore1Names): void {
  ;({
    BUILD_CHUNK_SIZE,
    BUILD_RETRY_FIRST_DELAY_MS,
    BUILD_RETRY_MAX_DELAY_MS,
    BUILD_STEPS_BETWEEN_CLOCK_CHECKS,
    DEFAULT_FILTER_THRESHOLD,
    DEFAULT_PROMOTION_THRESHOLD,
    DEFAULT_VECTOR_METRIC,
    DISK_ADOPTION_YIELD_INTERVAL,
    DRIFT_CHECK_GROWTH_FACTOR,
    ESTIMATED_MS_PER_TOMBSTONE,
    ESTIMATED_MS_PER_VECTOR_REBUILD,
    GRAPH_RETIRED,
    IN_MEMORY,
    MIN_OVERSAMPLE,
    NATIVE_OK,
    NOTHING_STAGED,
    NO_LIVE_VECTOR_AT_POSITION,
    QUERY_STAGED,
    RECALIBRATION_CHUNK_VECTORS,
    RECALIBRATION_DRIFT_RATIO,
    REFUSAL_COLLECTION_MIN_INTERVAL_MS,
    REFUSAL_COLLECTION_TIME_MULTIPLE,
    REFUSAL_YOUNG_COLLECTION_MIN_INTERVAL_MS,
    SEARCH_ATTEMPTS_BEFORE_HOLDING_WRITES,
    SEARCH_REFILL_RESERVE,
    SEARCH_SCAN_CHUNK_VECTORS,
    SHUFFLED_REBUILD_MEMORY_RETRY_MS,
    STORE_BLOCK_COUNT,
    STORE_CALIBRATED,
    STORE_CALIBRATION_GENERATION,
    STORE_CODE_BLOCK_COUNT,
    STORE_CODE_COUNT,
    STORE_DOC_ID_BYTES,
    STORE_LIVE_COUNT,
    STORE_ORDINAL_LAYOUT_GENERATION,
    STORE_RELEASED_VECTORS_TO_DISK,
    STORE_REMOVED_COUNT,
    STORE_SLOTS,
    STORE_UNPLACED_COUNT,
    UI_THREAD_BACKGROUND_SLICE_DURING_WRITES_MS,
    UI_THREAD_HOP_BEFORE_TURN_WITHIN_MS,
    UI_THREAD_TURN_BUDGET_MS,
    VECTOR_MEMORY_LIMITS,
    VECTOR_WORKER_COPIES_ALLOWED,
    WORKER_COPY_MIN_VECTORS,
    addToOrdinalFilter,
    admissionAt,
    adoptBackgroundScheduler,
    adoptGraph,
    adoptLoadedCalibration,
    allLiveDocIds,
    arenaFloat32Distance,
    assignStorePartitions,
    backgroundTurnIsSpent,
    blocksGrowthBytes,
    bytesToVectors,
    centroidOfCentroidSums,
    collectAndReturnPages,
    collectYoungGeneration,
    cosineSimilarityWithMagnitudes,
    countOfCentroidSums,
    createCentroidSums,
    createHNSWIndex,
    createOrdinalFilter,
    createOsqQuantizer,
    createSharedVectorStoreHandles,
    createVectorBlock,
    createVectorFileReader,
    defaultQuantizationFor,
    deserialize,
    detachNativeStore,
    dotProduct,
  } = vectorCore)
}
