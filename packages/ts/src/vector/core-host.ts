import type { OptionalCodeHost } from '../engine/optional-code-host'

export { compareCodePoints } from '../core/ordering'
export { MAX_DOC_ID_LENGTH } from '../engine/constants'
export { ErrorCodes, NarsilError } from '../errors'
export { MAX_FILE_BYTES } from '../serialization/constants'
export { threadSlotGone } from '../workers/thread-slot'
export {
  GRAPH_LOCK_WAIT_DEADLINE_MS,
  GRAPH_LOCK_WAIT_SLICE_MS,
  LOCK_SPIN_ITERATIONS,
  LOCK_WAIT_SLICE_MS,
  MAX_DOC_ID_TABLE_BYTES,
  MAX_VECTOR_ORDINALS,
  MAX_WASM_PAGES,
  NATIVE_ATTACH_RETRY_MS,
  NATIVE_THREAD_SEARCH_SLOTS,
  UNPLACED_FLAG_CHUNK_ORDINALS,
  VECTOR_BLOCK_INITIAL_SLOTS,
  VECTOR_BLOCK_MAX_BYTES,
  VECTOR_SCRATCH_SLOTS,
  VECTOR_STORE_INITIAL_CAPACITY,
  WASM_PAGE_BYTES,
} from './constants'
export {
  COMPACTION_ABSOLUTE_THRESHOLD,
  COMPACTION_TOMBSTONE_RATIO,
  CONNECT_RESTARTS_BEFORE_ONE_PASS,
  CONNECT_STEPS_BETWEEN_CLOCK_CHECKS,
  DEFAULT_EF_SEARCH,
  EARLIER_RELEASE_MIN_M,
  FARTHEST_REJECTED_LINKS_KEPT,
  INITIAL_LIST_CAPACITY,
  INITIAL_UPPER_SLOTS,
  MAX_LAYER_CAP,
  MAX_M,
  MIN_M,
  NEAREST_LINK_FALLBACK_HOSTS,
  PLACEMENT_ROOM_REQUESTS,
} from './hnsw/constants'

export function bindVectorCoreHost(_host: OptionalCodeHost): void {}
