import type { NodeCapacity } from '../coordinator/types'

/**
 * The cluster splits an index into this many partitions when
 * {@link CreateIndexOptions} names no count.
 *
 * @public
 */
export const DEFAULT_PARTITION_COUNT = 5

/**
 * The cluster keeps this many copies of each partition when
 * {@link CreateIndexOptions} names no factor. One copy means a lost node costs
 * that partition, so raise it for anything you cannot rebuild.
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

export const CAPACITY_EXHAUSTED_BACKOFF_BASE_MS = 100
export const CAPACITY_EXHAUSTED_BACKOFF_MAX_MS = 500
export const JITTERED_BACKOFF_POLL_INTERVAL_MS = 20

export const DEFAULT_BOOTSTRAP_SYNC_DEADLINE_MS = 600_000
export const SYNCED_POSITION_REPORT_TIMEOUT_MS = 5_000

export const ADMISSION_TIMEOUT_MS = 10_000
export const CATCH_UP_TICK_MS = 1_000
export const MAX_CATCH_UP_IN_FLIGHT_BYTES = 67_108_864

export const CLEAR_PAGE_SIZE = 1_000

export const DEFAULT_MAX_CONCURRENT_SNAPSHOTS = 2
export const DEFAULT_MAX_PER_SOURCE_SNAPSHOTS = 1
export const DEFAULT_MAX_STREAMS_PER_INDEX = 4
export const SNAPSHOT_CHUNK_YIELD_INTERVAL_MS = 8
export const MAX_SNAPSHOT_SYNC_REQUEST_BYTES = 4_096
export const MAX_SOURCE_ID_LENGTH = 256

export const MAX_WAIT_FOR_ACTIVE_REPLICAS = 255
export const MIN_CONTROLLER_LEASE_TTL_MS = 1_000
