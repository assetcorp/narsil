/**
 * How well the cluster holds an index, or the whole cluster, from the best status to the worst.
 *
 * `green` means every partition is `ACTIVE` with a primary and `replicationFactor` in-sync replicas. `yellow` means
 * every partition has a primary but some partition holds fewer in-sync replicas. `red` means some partition has no
 * primary, so the documents that it holds can be neither read nor written. A primary or a replica counts only while
 * its node stays registered with the coordinator, because a copy on a node that has left serves nothing.
 *
 * @public
 */
export type ClusterHealthStatus = 'green' | 'yellow' | 'red'

/**
 * How well the cluster holds one index.
 *
 * @public
 */
export interface IndexHealth {
  /** The index that the cluster holds. */
  indexName: string
  /** The status of the index, which its weakest partition sets. */
  status: ClusterHealthStatus
  /** The number of partitions that the index has. */
  partitionCount: number
  /** The number of in-sync replicas besides the primary that each partition should keep. */
  replicationFactor: number
  /** The number of partitions that have no primary. */
  partitionsWithoutPrimary: number
  /** The number of partitions that have a primary but are not `ACTIVE` or hold fewer in-sync replicas than the factor. */
  underReplicatedPartitions: number
}

/**
 * How well the cluster holds every index that it serves.
 *
 * @public
 */
export interface ClusterHealth {
  /** The worst status of any index, or `green` for a cluster that holds no index. */
  status: ClusterHealthStatus
  /** One entry per index, sorted by name. */
  indexes: IndexHealth[]
}

/**
 * How far one replica trails the primary of its partition.
 *
 * @public
 */
export interface ReplicaLagFigure {
  /** The index that the partition belongs to. */
  indexName: string
  /** The partition within that index. */
  partitionId: number
  /** The node that holds the replica. */
  replica: string
  /** The primary's last sequence number minus the highest sequence number that the replica acknowledged. */
  lag: number
}

/**
 * What the allocation table records for one partition.
 *
 * @public
 */
export interface PartitionReplicationFigure {
  /** The index that the partition belongs to. */
  indexName: string
  /** The partition within that index. */
  partitionId: number
  /**
   * The floor on the commit point that the allocation table stores, which the controller raises only when it admits
   * a replica, so it can trail the commit point of the partition's leader by many writes.
   */
  commitPointFloor: number
  /** The number of replicas besides the primary that are in the in-sync set. */
  inSyncReplicas: number
}

/**
 * The live commit point of one partition that this node leads.
 *
 * @public
 */
export interface CommitPointFigure {
  /** The index that the partition belongs to. */
  indexName: string
  /** The partition within that index. */
  partitionId: number
  /** The highest sequence number that this node has acknowledged to a client for the partition. */
  commitPoint: number
}

/**
 * How long this node's calls to the coordinator took, for one kind of call.
 *
 * @public
 */
export interface CoordinatorRequestFigure {
  /** The coordinator method that the node called, such as `getAllocation`. */
  operation: string
  /** The upper bound of each bucket in seconds, in ascending order. */
  bucketBoundsSeconds: number[]
  /** The number of calls that took no longer than each bound, so each count includes the ones before it. */
  bucketCounts: number[]
  /** The number of calls, including those slower than every bound. */
  count: number
  /** The total time that the calls took, in seconds. */
  sumSeconds: number
}

/**
 * The replication and coordinator figures that one node reports.
 *
 * @public
 */
export interface ClusterMetrics {
  /** The lag of each replica of each partition that this node leads. */
  replicationLag: ReplicaLagFigure[]
  /** The live commit point of each partition that this node leads. */
  commitPoints: CommitPointFigure[]
  /** The stored commit point floor and the in-sync replica count of every partition in the cluster. */
  partitions: PartitionReplicationFigure[]
  /** The timing of this node's coordinator calls, one entry per kind of call that the node has made. */
  coordinatorRequests: CoordinatorRequestFigure[]
}
