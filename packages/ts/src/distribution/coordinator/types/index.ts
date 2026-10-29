import type { SchemaDefinition } from '../../../types/schema'
import type { NodeEvent, NodeRegistration, RegistrationLease } from './node'

export type {
  IndexPartitionBytes,
  NodeCapacity,
  NodeEvent,
  NodeMemoryReport,
  NodeRegistration,
  NodeRole,
  RegistrationLease,
} from './node'

/**
 * Where one partition stands in its move between nodes.
 *
 * `ACTIVE` is the steady state. `INITIALISING` means a node is still filling
 * it, `MIGRATING` means it is moving, `DECOMMISSIONING` means it is being
 * drained, and `UNASSIGNED` means no node holds it.
 *
 * @public
 */
export type PartitionState = 'UNASSIGNED' | 'INITIALISING' | 'ACTIVE' | 'MIGRATING' | 'DECOMMISSIONING'

/**
 * Why a partition stays `UNASSIGNED` after the controller has asked its last holders for a copy.
 *
 * `HOLDER_OFFLINE` means a last holder has yet to register again, so the controller is still waiting for it.
 * `HOLDER_UNREACHABLE` means a registered holder left the request unanswered or answered with a payload the
 * controller could not read. `HOLDER_IDENTITY_MISMATCH` means a holder answered under a different index identity,
 * so its copy holds the documents of an earlier index of the same name, or it keeps no copy of that name at all.
 * `HOLDER_WITHOUT_DATA` means every holder answered under the coordinator's identity with a list that left the
 * partition out.
 *
 * @public
 */
export type UnassignedReason =
  | 'HOLDER_OFFLINE'
  | 'HOLDER_UNREACHABLE'
  | 'HOLDER_IDENTITY_MISMATCH'
  | 'HOLDER_WITHOUT_DATA'

/**
 * Which nodes hold one partition, and where that partition stands.
 *
 * @public
 */
export interface PartitionAssignment {
  /** This node accepts writes, and it is `null` while no node holds the partition. */
  primary: string | null
  /** These nodes each hold a copy, including the primary. */
  replicas: string[]
  /** These replicas are current enough to be promoted, which is the set a failover picks from. */
  inSyncSet: string[]
  /**
   * The controller is moving the copies on these nodes elsewhere, and each one stays in `replicas` and in `inSyncSet`
   * until the copies outside this list reach the replication factor in sync. The field is absent while no move is
   * under way.
   */
  removingReplicas?: string[]
  /** These nodes still hold a copy of a partition no node serves, and the field stays until the partition is `ACTIVE`. */
  lastHolders?: string[]
  /** This says where the partition stands in its move between nodes. */
  state: PartitionState
  /** This rises each time the primary changes, which is what makes a stale primary's writes detectable. */
  primaryTerm: number
  /** The primary has acknowledged every sequence number up to here, so every in-sync replica holds them. */
  commitPoint: number
  /** Why the partition stays `UNASSIGNED`, which the controller records each time it asks the last holders. */
  unassignedReason?: UnassignedReason
}

/**
 * How one index's partitions are spread across the cluster.
 *
 * @public
 */
export interface AllocationTable {
  /** The table covers this index. */
  indexName: string
  /** This rises on every change, so a writer detects that another controller got there first. */
  version: number
  /** The cluster keeps this many copies of each partition. */
  replicationFactor: number
  /** These assignments are keyed by partition id. */
  assignments: Map<number, PartitionAssignment>
  /**
   * The name of the index that serves this index name since a partition count change finished. A table that carries
   * it holds no assignments, and every read, write, and metadata lookup for this name goes to that index. The field
   * is absent until the first change of the partition count.
   */
  generation?: string
}

/**
 * Tells watchers that an index's allocation changed.
 *
 * @public
 */
export interface AllocationEvent {
  /** This index's allocation changed. */
  indexName: string
  /** The allocation now stands like this. */
  table: AllocationTable
}

/**
 * Tells watchers that an index's schema was published or dropped.
 *
 * @public
 */
export interface SchemaEvent {
  /** This says which change it is. */
  type: 'schema_created' | 'schema_dropped'
  /** This index's schema changed. */
  indexName: string
  /** This is the schema, and it is `null` when the index was dropped. */
  schema: SchemaDefinition | null
}

/**
 * The rules the allocator respects when it places partitions.
 *
 * The controller stores these with each index's metadata, so every node
 * allocating that index applies the same rules.
 *
 * @public
 */
export interface AllocationConstraints {
  /** Setting this spreads an index's replicas across zones, so losing one zone never costs every copy. */
  zoneAwareness: boolean
  /** This names the key in a node's `metadata` that carries its zone. */
  zoneAttribute: string
  /** One node may hold this many partitions of an index, and `null` lifts the ceiling. */
  maxShardsPerNode: number | null
}

/**
 * The shared state every cluster node reads and writes: which nodes exist,
 * which node holds each partition, who holds which lease, and what each
 * index's schema is.
 *
 * The package includes an etcd-backed coordinator for real deployments and an
 * in-memory one for tests, and this is the contract either satisfies. Write
 * your own to run a cluster on another store, so long as
 * {@link ClusterCoordinator.compareAndSet} and the lease calls are atomic,
 * because the controller election depends on them.
 *
 * @public
 */
export interface ClusterCoordinator {
  /**
   * Publishes a node so that peers find it, and keeps it published while the
   * node heartbeats.
   *
   * @param registration - What the node publishes about itself.
   */
  registerNode(registration: NodeRegistration): Promise<void>
  /**
   * Removes a node, so the controller reallocates whatever it held.
   *
   * @param nodeId - The node to remove.
   */
  deregisterNode(nodeId: string): Promise<void>
  /**
   * Reports how much longer the coordinator is certain to hold a node's
   * registration, which is how long the node may keep acting as a primary.
   *
   * A primary refuses writes with `PARTITION_NOT_PRIMARY` once this time runs
   * out, because the controller may then have promoted another copy. A
   * coordinator that leaves this member out gets no such fence, so a primary
   * that loses touch with it keeps answering writes until it reads a newer
   * allocation table.
   *
   * @param nodeId - The node whose registration this process wrote.
   * @returns The time left and the lease lifetime it counts against, or
   * `null` where this process holds no live registration for the node.
   */
  registrationLease?(nodeId: string): RegistrationLease | null
  /**
   * Lists the nodes currently published.
   *
   * @returns One registration per live node.
   */
  listNodes(): Promise<NodeRegistration[]>
  /**
   * Watches nodes joining and leaving.
   *
   * @param handler - Called once per change.
   * @returns A function that ends the watch.
   */
  watchNodes(handler: (event: NodeEvent) => void): Promise<() => void>

  /**
   * Reads one index's allocation.
   *
   * @param indexName - The index to read.
   * @returns Its allocation, or `null` when the index has none yet.
   */
  getAllocation(indexName: string): Promise<AllocationTable | null>
  /**
   * Writes one index's allocation without checking the stored version or the
   * controller lease, which only a test or an operator's repair should do.
   *
   * @param indexName - The index to write.
   * @param table - The allocation to store.
   * @returns True once the write has gone through.
   */
  putAllocation(indexName: string, table: AllocationTable): Promise<boolean>
  /**
   * Writes one index's allocation while the stored table still carries the
   * version that the caller read and the writer still holds the controller
   * lease, checking both in one atomic operation.
   *
   * @param indexName - The index to write.
   * @param table - The allocation to store.
   * @param expectedVersion - The version that the caller read, or `null` to
   * write only while the index has no allocation yet.
   * @param writerNodeId - The node that writes the table, which must hold the
   * `_narsil/controller` lease when the write takes effect.
   * @returns True when the write went through, and false when the stored
   * version no longer matched or the writer did not hold the controller lease.
   */
  putAllocation(
    indexName: string,
    table: AllocationTable,
    expectedVersion: number | null,
    writerNodeId: string,
  ): Promise<boolean>
  /**
   * Removes one index's allocation, which is the last step of dropping the
   * index. Deleting an allocation that does not exist does nothing.
   *
   * @param indexName - The index whose allocation goes.
   */
  deleteAllocation(indexName: string): Promise<void>
  /**
   * Watches allocations changing.
   *
   * @param handler - Called once per change.
   * @returns A function that ends the watch.
   */
  watchAllocation(handler: (event: AllocationEvent) => void): Promise<() => void>

  /**
   * Reads where one partition stands.
   *
   * @param indexName - Index the partition belongs to.
   * @param partitionId - The partition to read.
   * @returns Its state, or `UNASSIGNED` when nothing is recorded.
   */
  getPartitionState(indexName: string, partitionId: number): Promise<PartitionState>
  /**
   * Records where one partition stands.
   *
   * @param indexName - Index the partition belongs to.
   * @param partitionId - The partition to record.
   * @param state - Its new state.
   */
  putPartitionState(indexName: string, partitionId: number, state: PartitionState): Promise<void>

  /**
   * Takes a lease, which is how one node wins the controller election.
   *
   * @param key - The lease to take.
   * @param nodeId - The node taking it.
   * @param ttlMs - Milliseconds the lease survives without renewal.
   * @returns True when this node now holds the lease.
   */
  acquireLease(key: string, nodeId: string, ttlMs: number): Promise<boolean>
  /**
   * Extends a lease this node already holds.
   *
   * @param key - The lease to extend.
   * @param nodeId - The node that holds it.
   * @param ttlMs - Milliseconds the lease survives from now.
   * @returns True when the lease was extended, and false once it has been
   * lost, which means the node has to step down.
   */
  renewLease(key: string, nodeId: string, ttlMs: number): Promise<boolean>
  /**
   * Gives a lease up straight away, rather than waiting for it to expire.
   *
   * @param key - The lease to release.
   */
  releaseLease(key: string): Promise<void>

  /**
   * Reads one key of cluster metadata.
   *
   * @param key - The key to read.
   * @returns Its bytes, or `null` when the key holds nothing.
   */
  get(key: string): Promise<Uint8Array | null>
  /**
   * Writes one key of cluster metadata only while it still holds what the
   * caller read, which is what makes concurrent controllers safe.
   *
   * @param key - The key to write.
   * @param expected - The bytes the caller read, or `null` to write only while
   * the key holds nothing.
   * @param value - The bytes to store.
   * @returns True when the write went through.
   */
  compareAndSet(key: string, expected: Uint8Array | null, value: Uint8Array): Promise<boolean>
  /**
   * Removes one key of cluster metadata, and does nothing when the key already
   * holds nothing.
   *
   * @param key - The key to remove.
   */
  delete(key: string): Promise<void>

  /**
   * Reads one index's schema, which is how a node joining later learns the
   * layout of an index it has never held.
   *
   * @param indexName - The index to read.
   * @returns Its schema, or `null` when the index is unknown.
   */
  getSchema(indexName: string): Promise<SchemaDefinition | null>
  /**
   * Publishes one index's schema to the cluster.
   *
   * @param indexName - The index to publish.
   * @param schema - Its field layout.
   */
  putSchema(indexName: string, schema: SchemaDefinition): Promise<void>
  /**
   * Removes one index's schema and tells every watcher it was dropped, which
   * starts the cluster-wide teardown of that index. Dropping a schema that
   * does not exist does nothing.
   *
   * @param indexName - The index whose schema goes.
   */
  dropSchema(indexName: string): Promise<void>
  /**
   * Lists the name of every published schema, which is how a newly elected
   * controller finds the indexes it must reconcile.
   *
   * @returns Every index name holding a schema, sorted by code point.
   */
  listSchemas(): Promise<string[]>
  /**
   * Watches schemas being published and dropped.
   *
   * @param handler - Called once per change.
   * @returns A function that ends the watch.
   */
  watchSchemas(handler: (event: SchemaEvent) => void): Promise<() => void>

  /**
   * Reads which node holds a lease, which is how a node finds the active
   * controller.
   *
   * @param key - The lease to look up.
   * @returns The holder's node id, or `null` when nobody holds it.
   */
  getLeaseHolder(key: string): Promise<string | null>

  /** Releases every lease and watch this node opened, then closes the connection. */
  shutdown(): Promise<void>
}
