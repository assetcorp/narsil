import type { Narsil } from '../../../narsil'
import type { ClusterCoordinator, NodeCapacity, NodeRole } from '../../coordinator/types'
import type { NodeTransport } from '../../transport/types'

export interface ClusterNodeDeps {
  nodeId: string
  roles: ReadonlyArray<NodeRole>
  coordinator: ClusterCoordinator
  transport: NodeTransport
  engine: Narsil
  address: string
}

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
