import type { SchemaDefinition } from '../../../types/schema'
import type { AllocationEvent, AllocationTable, ExpectedReplicaRegistration, PartitionState } from './allocation'
import type { IndexMetadataWatch } from './index-metadata'
import type { NodeEvent, NodeRegistration, RegistrationLease } from './node'

export type {
  AllocationConstraints,
  AllocationEvent,
  AllocationTable,
  ExpectedReplicaRegistration,
  PartitionAssignment,
  PartitionState,
  UnassignedReason,
} from './allocation'
export type { IndexMetadataEvent, IndexMetadataWatch } from './index-metadata'
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
export interface ClusterCoordinator extends IndexMetadataWatch {
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
   * Renews a node's registration lease once and reports how much longer the
   * coordinator holds the registration after that renewal.
   *
   * A primary calls this before it refuses a write because
   * {@link ClusterCoordinator.registrationLease} reports too little time
   * left, so that a node whose renewals ran late behind its own work keeps
   * serving. The coordinator cannot renew a lease that has already expired,
   * so an accepted renewal shows that the registration stayed held
   * throughout. A coordinator that leaves this member out leaves the
   * primary with the reading from `registrationLease` alone.
   *
   * @param nodeId - The node whose registration this process wrote.
   * @returns The time left after the renewal and the lease lifetime it counts
   * against, or `null` where this process holds no live registration for the
   * node.
   */
  confirmRegistrationLease?(nodeId: string): Promise<RegistrationLease | null>
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
   * lease, checking those two and any replica registration that the caller
   * gives in one atomic operation.
   *
   * @param indexName - The index to write.
   * @param table - The allocation to store.
   * @param expectedVersion - The version that the caller read, or `null` to
   * write only while the index has no allocation yet.
   * @param writerNodeId - The node that writes the table, which must hold the
   * `_narsil/controller` lease when the write takes effect.
   * @param replicaRegistration - A replica whose registration must carry the
   * given `startedAt` when the write takes effect, which the controller
   * passes when the write admits that replica to the in-sync set.
   * @returns True when the write went through, and false when the stored
   * version no longer matched, the writer did not hold the controller lease,
   * or the replica was not registered with that `startedAt`.
   */
  putAllocation(
    indexName: string,
    table: AllocationTable,
    expectedVersion: number | null,
    writerNodeId: string,
    replicaRegistration?: ExpectedReplicaRegistration,
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
