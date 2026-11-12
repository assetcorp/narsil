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
   * The controller raises this by 1 in every table write that changes `inSyncSet`, that accepts an in-sync removal, or
   * that removes a node from `replicas`, and by 1 once where a write makes more than one of those changes. It refuses
   * an admission that carries any other value, so an admission that a primary asked for before a removal, or before
   * the replica left the assignment and dropped its copy, never adds the replica back. A table that an earlier release
   * wrote leaves it absent, and every reader counts an absent value as 0.
   */
  inSyncVersion?: number
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
  /**
   * The identity of the index that this table allocates, which the controller copies from the index metadata. When a
   * node holds a table for a name and receives one with a different uuid, it takes the received table whatever the two
   * versions are, because the name then refers to another index. The field is absent from a table that an earlier
   * release wrote.
   */
  indexUuid?: string
}

/**
 * The registration that an allocation write expects a replica to hold when the write takes effect, which is how the
 * controller keeps a replica that restarted after the primary proved its position out of the in-sync set.
 *
 * @public
 */
export interface ExpectedReplicaRegistration {
  /** The replica's node. */
  nodeId: string
  /** The `startedAt` that the replica's registration must carry, which a node writes anew on every start. */
  startedAt: string
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
