import type { SchemaDefinition } from '../../types/schema'

/**
 * What a node does in a cluster. A node may hold several roles at once.
 *
 * A `data` node holds partitions and answers queries, a `coordinator` node
 * routes requests without holding data, and a `controller` node runs the
 * allocation decisions for the whole cluster.
 *
 * @public
 */
export type NodeRole = 'data' | 'coordinator' | 'controller'

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
 * What one node has to offer, which the allocator weighs when it places
 * partitions.
 *
 * @public
 */
export interface NodeCapacity {
  /** The node can give this much memory to indexes. */
  memoryBytes: number
  /** The node has this many cores available. */
  cpuCores: number
  /** The node can give this much disk to durability, and reports `null` when it keeps nothing on disk. */
  diskBytes: number | null
}

/**
 * What a node publishes about itself when it joins a cluster.
 *
 * @public
 */
export interface NodeRegistration {
  /** This identifies the node across the cluster, and must stay stable across restarts. */
  nodeId: string
  /** Peers reach the node at this address, as the transport writes it. */
  address: string
  /** The node holds these roles in the cluster. */
  roles: NodeRole[]
  /** The node offers this much capacity. */
  capacity: NodeCapacity
  /** The node started at this ISO 8601 timestamp. */
  startedAt: string
  /** The node runs this engine version, which is what a mixed-version cluster reads. */
  version: string
  /** These free-form labels are where a zone or rack goes for zone-aware allocation. */
  metadata?: Record<string, string>
}

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
}

/**
 * Tells watchers that a node joined or left.
 *
 * @public
 */
export interface NodeEvent {
  /** This says which change it is. */
  type: 'node_joined' | 'node_left'
  /** This node joined or left. */
  nodeId: string
  /** The node published this on joining, and it is `null` when the node left. */
  registration: NodeRegistration | null
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
   * Writes one index's allocation, optionally only while nobody else has
   * changed it first.
   *
   * @param indexName - The index to write.
   * @param table - The allocation to store.
   * @param expectedVersion - The version the caller read, `null` to write only
   * while no allocation exists, or omit it to write unconditionally.
   * @returns True when the write went through, and false when the expected
   * version no longer matched.
   */
  putAllocation(indexName: string, table: AllocationTable, expectedVersion?: number | null): Promise<boolean>
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
