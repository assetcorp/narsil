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
 * How much memory one node uses against its limits, which the node publishes with every heartbeat so that the cluster
 * stops taking writes before the node runs out of memory.
 *
 * @public
 */
export interface NodeMemoryReport {
  /** The whole process holds this many bytes of resident memory, including vectors and segments kept outside the heap. */
  processBytes: number
  /** The process may hold this many bytes, which is the container's memory limit or else the host's total memory. */
  processLimitBytes: number
  /**
   * The main thread's old generation uses this many bytes. The old generation is the V8 heap without the young
   * generation, which holds new objects until the collector empties it.
   */
  heapBytes: number
  /**
   * The main thread's old generation may grow to this many bytes. This is the `--max-old-space-size` figure where the
   * process sets it, and otherwise V8's heap limit less the young generation's share.
   */
  heapLimitBytes: number
  /**
   * This is true while the node refuses writes, which starts once either figure passes the block fraction of its limit
   * and ends once both fall below the resume fraction. Every index with a copy on the node refuses inserts and updates
   * with `CLUSTER_WRITE_BLOCKED` while it holds.
   */
  full: boolean
}

/**
 * The estimated size of each partition copy that one node holds of one index, which the controller weighs when it
 * places further copies.
 *
 * @public
 */
export interface IndexPartitionBytes {
  /** The partitions belong to this index. */
  indexName: string
  /** Each entry pairs a partition id with the estimated bytes that the node's copy of it holds. */
  partitions: Array<[partitionId: number, bytes: number]>
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
  /** The node uses this much memory, and the field is absent where the node's runtime cannot measure it. */
  memory?: NodeMemoryReport
  /**
   * The node's copies hold these estimated sizes. The controller counts a partition that no node reports as 50 MB
   * when it places copies.
   */
  partitionBytes?: IndexPartitionBytes[]
  /**
   * The node is leaving the cluster where this is true, so the controller places no new copy on it and moves every
   * copy it holds to other nodes. An absent value counts as false.
   */
  draining?: boolean
}

/**
 * How long the coordinator is certain to keep holding a node's registration,
 * measured from the moment the node sent the last renewal that the
 * coordinator accepted.
 *
 * @public
 */
export interface RegistrationLease {
  /** The registration stays held for at least this many more milliseconds, and the figure falls below zero once that time has passed. */
  remainingMs: number
  /** The coordinator granted the lease for this many milliseconds, which is the lifetime that `remainingMs` counts down from. */
  ttlMs: number
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
