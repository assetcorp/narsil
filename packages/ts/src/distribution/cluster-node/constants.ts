import type { NodeCapacity } from '../coordinator/types'

/**
 * The cluster splits an index into this many partitions when
 * {@link CreateIndexOptions} names no count.
 *
 * @public
 */
export const DEFAULT_PARTITION_COUNT = 5

/**
 * The cluster keeps this many replicas of each partition, besides its
 * primary, when {@link CreateIndexOptions} names no factor. One replica
 * gives two copies of every partition, so the cluster keeps each partition
 * through the loss of one node, and 0 leaves a partition with its primary
 * alone.
 *
 * @public
 */
export const DEFAULT_REPLICATION_FACTOR = 1

/**
 * A node claims this much capacity when {@link ClusterNodeConfig} declares
 * none. Measure your own hosts and set it, because these figures are a
 * placeholder rather than a reading.
 *
 * @public
 */
export const DEFAULT_CAPACITY: NodeCapacity = {
  memoryBytes: 8_000_000_000,
  cpuCores: 4,
  diskBytes: null,
}

export const DEFAULT_CREATE_INDEX_WAIT_MS = 30_000

export const DECOMMISSION_RECHECK_INTERVAL_MS = 1_000
export const COORDINATOR_REQUEST_BUCKET_BOUNDS_SECONDS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]

export const CAPACITY_EXHAUSTED_BACKOFF_BASE_MS = 100
export const CAPACITY_EXHAUSTED_BACKOFF_MAX_MS = 500
export const JITTERED_BACKOFF_POLL_INTERVAL_MS = 20

export const DEFAULT_BOOTSTRAP_SYNC_DEADLINE_MS = 600_000
export const SYNCED_POSITION_REPORT_TIMEOUT_MS = 5_000

export const REGISTRATION_LEASE_DRIFT_SHARE = 0.1
export const REGISTRATION_LEASE_CONFIRM_TIMEOUT_MS = 5_000

export const ADMISSION_TIMEOUT_MS = 10_000
export const CATCH_UP_TICK_MS = 1_000
export const CATCH_UP_FEED_WINDOW_MS = 1_000
export const MAX_CATCH_UP_IN_FLIGHT_BYTES = 67_108_864

export const CLEAR_PAGE_SIZE = 1_000

export const MAX_SYNONYM_REPLACEMENT_ATTEMPTS = 5

export const DEFAULT_MAX_CONCURRENT_SNAPSHOTS = 2
export const DEFAULT_MAX_PER_SOURCE_SNAPSHOTS = 1
export const DEFAULT_MAX_STREAMS_PER_INDEX = 4
export const SNAPSHOT_CHUNK_YIELD_INTERVAL_MS = 8
export const WRITE_APPLY_YIELD_INTERVAL_MS = 8
export const MAX_SNAPSHOT_SYNC_REQUEST_BYTES = 4_096
export const MAX_SOURCE_ID_LENGTH = 256

export const MAX_WAIT_FOR_ACTIVE_REPLICAS = 255
export const MIN_CONTROLLER_LEASE_TTL_MS = 1_000
export const PRIMARY_CHANGE_RETRY_WINDOW_MS = 30_000
export const PRIMARY_CHANGE_POLL_INTERVAL_MS = 50
export const FORWARD_RETRY_INITIAL_DELAY_MS = 50
export const FORWARD_RETRY_DELAY_CAP_MS = 1_000
export const PARTITION_WRITE_CONCURRENCY = 16
export const MAX_NODE_LEFT_DELAY_MS = 2_147_483_647

export const DEFAULT_BLOCK_WRITES_ABOVE = 0.9
export const DEFAULT_RESUME_WRITES_BELOW = 0.8
export const MEMORY_SAMPLE_INTERVAL_MS = 1_000
export const RECENT_MEMORY_FIGURES_MAX_AGE_MS = 10
export const RECENT_MEMORY_FIGURES_MAX_ADMITTED_FRACTION = 0.01
export const FULL_MEMORY_COLLECTION_INTERVAL_MS = 5_000
export const PARTITION_BYTES_REPORT_BUDGET_BYTES = 262_144
export const PARTITION_BYTES_ENTRY_BYTES = 16
export const PARTITION_BYTES_INDEX_OVERHEAD_BYTES = 32
export const DEFAULT_IN_FLIGHT_WRITE_FRACTION = 0.02
export const WRITE_MEMORY_SAMPLE_MAX_AGE_MS = 100
export const DOCUMENT_NUMBER_BYTES = 8
export const DOCUMENT_SCALAR_BYTES = 4
export const DOCUMENT_ENTRY_OVERHEAD_BYTES = 2
export const DOCUMENT_HEAP_BYTES_PER_ESTIMATED_BYTE = 24
export const DOCUMENT_VALUE_HEAP_BYTES = 256
export const DOCUMENT_PROPERTY_HEAP_BYTES = 128
export const DISTINCT_TERM_HEAP_BYTES = 2_048
export const TERM_UNIT_HEAP_BYTES = 24
export const PARTIAL_SPELLING_HEAP_BYTES = 512
export const PATTERN_RUN_HEAP_BYTES = 512
export const ENUM_VALUE_HEAP_BYTES = 256
export const VECTOR_COMPONENT_HEAP_BYTES = 80
export const VECTOR_DOCUMENT_HEAP_BYTES = 5_120
export const NORMALIZATION_EXPANSION_FACTOR = 3
export const CASE_FOLD_EXPANSION_FACTOR = 3
export const MAX_DROP_ACKNOWLEDGE_WAIT_MS = 30_000
export const DROP_ACKNOWLEDGE_POLL_INTERVAL_MS = 25
export const COPY_FAILURE_RETRY_DELAY_MS = 100
export const COPY_FAILURE_ATTEMPTS = 600
