import type { OptionalCodeHost } from '../../engine/optional-code-host'
import type * as VectorCoreCode from '../core-leaf'

export { createDocIdMap } from '#platform/doc-id-tables'
export { collectAndReturnPages, collectYoungGeneration } from '#platform/idle-heap-cleanup'
export { spawnNodeWorker } from '#platform/node-worker'
export {
  backgroundTurnIsSpent,
  holdWritesAndBackgroundWork,
  turnsAreBudgeted,
  yieldBackgroundTurn,
} from '#platform/shared-turns'
export { turnIsSpent, yieldTurn } from '#platform/turn-budget'
export { createVectorFileReader } from '#platform/vector-file'
export { VECTOR_MEMORY_LIMITS } from '#platform/vector-memory-limits'
export { compareCodePoints } from '../../core/ordering'
export { bindSearchSignal, signalOfSearch } from '../../core/search-stop'
export { requirePinnedState } from '../../engine/query/state'
export { ErrorCodes, isNarsilError, NarsilError } from '../../errors'
export {
  REFUSAL_COLLECTION_MIN_INTERVAL_MS,
  REFUSAL_COLLECTION_TIME_MULTIPLE,
  REFUSAL_YOUNG_COLLECTION_MIN_INTERVAL_MS,
  UI_THREAD_BACKGROUND_SLICE_DURING_WRITES_MS,
  UI_THREAD_HOP_BEFORE_TURN_WITHIN_MS,
  UI_THREAD_TURN_BUDGET_MS,
} from '../../runtime/constants'
export { detectRuntime } from '../../runtime/detect'
export {
  DEFAULT_LINEAR_ALPHA,
  DEFAULT_RANK_CONSTANT,
  FUSION_TIE_INSERTION_LIMIT,
  MAX_LINEAR_ALPHA,
  MIN_LINEAR_ALPHA,
  MIN_RANK_CONSTANT,
  RESULT_WINDOW,
} from '../../search/constants'
export { WORKER_YOUNG_GENERATION_MB } from '../../workers/constants'
export { resolveWorkerEntry } from '../../workers/entry-point'
export { noteThreadSlotGone, noteThreadSlotLive } from '../../workers/thread-slot'
export { resolveWorkerCount } from '../../workers/worker-count'
export {
  DISK_STORAGE_BLOCK_BYTES,
  GRAPH_BUILD_CHUNKS_IN_FLIGHT_PER_WORKER,
  GRAPH_BUILD_DISPATCH_CHUNK,
  MAX_RENUMBERED_SEARCH_ATTEMPTS,
  NATIVE_THREAD_SCAN_CHUNK_ORDINALS,
  UNPLACED_FLAG_CHUNK_ORDINALS,
  VECTOR_INSERT_TIMEOUT_MS,
  VECTOR_SCRATCH_SLOTS,
  VECTOR_SEARCH_LOAD_TIMEOUT_MS,
  VECTOR_SEARCH_TIMEOUT_MS,
} from '../constants'
export { createHNSWIndex } from '../hnsw'
export { GRAPH_RETIRED } from '../hnsw/handles'
export { shuffleInPlace, shuffleStep } from '../hnsw/insertion-order'
export { releaseLocksHeldBy } from '../hnsw/locks'
export { insertNode } from '../hnsw/mutation'
export { requireWholeNeighbourLists, topLayerInParts } from '../hnsw/numbered-graph'
export { searchOrdinals } from '../hnsw/search'
export { nodeCountOf, toDistance, tombstoneCountOf, toScore } from '../hnsw/shared'
export { openGraphState } from '../hnsw/state'
export { noteFallback } from '../native/backend'
export {
  detachNativeStore,
  nativeMetricCode,
  nativeScoresOf,
  nativeStoreFor,
  nativeStoreScratchBytes,
} from '../native/store'
export { threadedNativeCore, withNativeThreadSlot } from '../native/thread-slots'
export { NATIVE_OK } from '../native/types'
export {
  addToOrdinalFilter,
  createOrdinalFilter,
  ordinalFilterForSubsets,
  ordinalFilterValues,
} from '../ordinal-filter'
export { ordinalFilterHas } from '../ordinal-membership'
export { createOsqQuantizer, osqBitsOf } from '../osq'
export { MIN_OVERSAMPLE } from '../osq/constants'
export {
  centroidOfCentroidSums,
  countOfCentroidSums,
  createCentroidSums,
  meanOfCentroidSums,
  squaredLengthsOfCentroidSums,
} from '../osq/quantize'
export { openSharedQuantizer } from '../osq/view'
export { requireUsableVectorOptions } from '../search-depth'
export { fixedView, growBufferTo, grownByteLength, sharedMemoryAvailable } from '../shared-buffers/growable'
export { arenaFloat32Distance } from '../simd'
export { cosineSimilarityWithMagnitudes, dotProduct, euclideanDistance, magnitude } from '../similarity'
export { planCheckpoint, recordCheckpoint, signatureOf } from '../vector-index/checkpoint-plan'
export {
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
  RECALIBRATION_CHUNK_VECTORS,
  RECALIBRATION_DRIFT_RATIO,
  SEARCH_ATTEMPTS_BEFORE_HOLDING_WRITES,
  SEARCH_REFILL_RESERVE,
  SEARCH_SCAN_CHUNK_VECTORS,
  SHUFFLED_REBUILD_MEMORY_RETRY_MS,
  WORKER_COPY_MIN_VECTORS,
} from '../vector-index/constants'
export { isDead, NO_LIVE_VECTOR_AT_POSITION } from '../vector-index/dead-bits'
export { defaultQuantizationFor } from '../vector-index/default-quantization'
export { bytesToVectors } from '../vector-index/payload'
export { deserialize } from '../vector-index/persistence'
export {
  adoptGraph,
  adoptLoadedCalibration,
  allLiveDocIds,
  assignStorePartitions,
  emptyFieldBeforeRestore,
  fieldHandlesOf,
  filterForOptions,
  graphNeedsRebuild,
  handOverBuildTurns,
  liveOrdinals,
  liveSize,
  noBuildHistory,
  recalibrateFromStore,
  releaseReplacedVectors,
  threadsHoldCurrentLayout,
  VECTOR_WORKER_COPIES_ALLOWED,
  yieldBuildTurn,
} from '../vector-index/shared'
export { admissionAt, holdAdmission, withTransientAdmission } from '../vector-store/admission'
export {
  blocksGrowthBytes,
  createVectorBlock,
  ensureBlockSlots,
  NOTHING_STAGED,
  openVectorBlock,
  QUERY_STAGED,
  slotByteOffset,
} from '../vector-store/blocks'
export {
  createSharedVectorStoreHandles,
  IN_MEMORY,
  resetStoreHeader,
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
  STORE_WRITE_SEQUENCE_INT64,
  sharedVectorStoreBytes,
  unplacedChunkCount,
  writeSequenceWords,
} from '../vector-store/handles'
export {
  coverOrdinal,
  mayFree,
  nextSequence,
  oldestHeldPin,
  publishSequence,
  releasePinsHeldBy,
  retiredAtOf,
  sequenceWritesOf,
  stampBorn,
  stampRetired,
  writeSequenceOf,
} from '../vector-store/pins'
export { storePinsOf } from '../vector-store/store-pins'

export function bindVectorHost(_host: OptionalCodeHost, _vectorCore: typeof VectorCoreCode): void {}
