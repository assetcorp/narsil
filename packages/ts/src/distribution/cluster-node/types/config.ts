import type { Narsil } from '../../../narsil'
import type { NarsilConfig } from '../../../types/config'
import type {
  AllocationTable,
  ClusterCoordinator,
  NodeCapacity,
  NodeRegistration,
  NodeRole,
} from '../../coordinator/types'
import type { ReplicationConfig } from '../../replication/types'
import type { NodeTransport } from '../../transport/types'
import type { ClusterHealth, ClusterMetrics } from './observability'

/**
 * Everything {@link createClusterNode} needs to join a node to a cluster.
 *
 * The coordinator and the transport are the two pieces you choose: the
 * coordinator holds the cluster's shared state, and the transport carries
 * messages between nodes.
 *
 * @public
 */
export interface ClusterNodeConfig {
  /** This node reads and writes the cluster's shared state here. Every node in a cluster must point at the same one. */
  coordinator: ClusterCoordinator
  /** This node reaches its peers through this transport. */
  transport: NodeTransport
  /** Peers reach this node at this address, as the transport writes it. */
  address: string
  /** This node holds these roles in the cluster, and holds data alone by default. */
  roles?: NodeRole[]
  /**
   * This identifies the node across the cluster. Where you leave it out, a node
   * with a durability directory generates an id once, stores it in that
   * directory, and reuses it on every later start, so that the controller
   * recognises the copies that the node holds after a restart. A node without a
   * durability directory takes a new id on every start.
   */
  nodeId?: string
  /** This node offers this much capacity, which the allocator weighs. It offers {@link DEFAULT_CAPACITY} by default. */
  capacity?: NodeCapacity
  /**
   * These settings configure the engine this node runs locally, such as its persistence and durability.
   *
   * When the node sends or receives a copy of an index, it writes that copy to disk so that the copy never has to fit
   * in memory. The copy goes into a `.snapshot-transfer` directory inside the durability directory, or into the
   * system's temporary directory when the engine has no durability directory, and the node deletes it once the
   * transfer ends.
   */
  engine?: NarsilConfig
  /** These replication settings override the engine's own, and anything you leave out keeps its value. */
  replication?: Partial<ReplicationConfig>
  /** These settings govern how this node gathers each search from the cluster, and anything you leave out keeps its default. */
  query?: ClusterQueryConfig
  /** These settings govern how this node stands for controller election, and anything you leave out keeps its default. */
  controller?: ClusterControllerConfig
  /** These settings govern when this node's memory blocks writes across the cluster, and anything you leave out keeps its default. */
  memory?: ClusterMemoryConfig
  /** This receives the failures the node reports while running on its own, away from any call you made. */
  onError?: (error: Error) => void
}

/**
 * When this node counts as full, which is what makes the cluster refuse inserts and updates to every index with a
 * copy on the node.
 *
 * The node measures its process memory against the container's limit, or the host's memory where no container sets
 * one, and its main thread's heap against the heap limit, once a second. It counts as full once either figure passes
 * `blockWritesAbove` of its limit, and as clear again once both fall below `resumeWritesBelow`, so that a node hovering
 * at the threshold does not switch writes on and off. Removes and searches go through while the node is full, which is
 * how an operator frees memory.
 *
 * @public
 */
export interface ClusterMemoryConfig {
  /**
   * The node counts as full once either memory figure passes this fraction of its limit. It must lie above
   * `resumeWritesBelow` and at most 1, and it is 0.9 where you name none.
   *
   * The node compares its heap with the smaller of this setting and 0.75. V8, the engine that runs Node.js, stops the
   * process after four full collections in a row that each leave the old generation holding at least 0.8 of its limit,
   * so a full node keeps its heap below that line. The node compares its resident memory with the setting as it is.
   */
  blockWritesAbove?: number
  /**
   * A full node counts as clear again once both memory figures fall below this fraction of their limits. It must lie
   * above 0 and below `blockWritesAbove`, and it is 0.8 where you name none.
   *
   * The node compares its heap with the smaller of this setting and 0.65, for the same V8 rule that caps the heap side
   * of `blockWritesAbove` at 0.75. The node compares its resident memory with the setting as it is.
   */
  resumeWritesBelow?: number
  /**
   * The node holds at most this fraction of its heap limit in the documents of inserts and updates that it has
   * accepted and not yet finished, counting both the writes that clients send it and the writes that other nodes
   * forward to it as primary. It refuses a write whose documents would carry that total past the limit with
   * `CLUSTER_WRITE_BLOCKED`, and the error's details include the reason `write_bytes_in_flight`. It accepts a write
   * of any size when no other insert or update is in progress, and it never refuses a replicated entry or a remove. The fraction must lie above 0 and at most 1, and it is 0.02 where you name none,
   * which is low because indexing a document can take many times the size of its text in heap. A value of 1 allows
   * writes in flight up to the whole heap limit.
   */
  inFlightWriteFraction?: number
}

/**
 * How long this node's turn as controller survives a fault, and how often it
 * stands for election again.
 *
 * A cluster fails over no faster than the lease it grants the controller, so a
 * demonstration lowers both figures and a busy cluster leaves them alone. Every
 * controller-capable node in a cluster should carry the same pair.
 *
 * @public
 */
export interface ClusterControllerConfig {
  /**
   * The controller lease survives this many milliseconds without a renewal, so
   * a controller that loses the coordinator keeps its claim for that long. The
   * active controller renews the lease every third of this, and a standby takes
   * the lease over up to {@link ClusterControllerConfig.standbyRetryMs} after it
   * expires. It is 15000 milliseconds where you name none.
   */
  leaseTtlMs?: number
  /**
   * A node that holds no lease stands for election again after this many
   * milliseconds, whether the lease was taken or the coordinator refused the
   * attempt. It is 5000 milliseconds where you name none.
   */
  standbyRetryMs?: number
  /**
   * The controller waits this many milliseconds after a data node leaves
   * before it moves that node's replicas to other nodes, which is 60000
   * milliseconds where you set none. It promotes a replica at once for every
   * partition that the node led, and a node that registers again under the
   * same node id within this time keeps its replicas and catches up on the
   * writes that it missed. Set 0 to move the replicas as soon as the node
   * leaves.
   */
  nodeLeftDelayMs?: number
}

/**
 * How this node answers a search when one of the nodes it asked runs slowly or
 * drops out.
 *
 * The defaults let a search answer from the nodes that did reply, so set
 * `allowPartialResults` to false where a caller must never act on an
 * incomplete count. Every search reports what it read in
 * {@link QueryResult.coverage} whichever way you set these.
 *
 * @public
 */
export interface ClusterQueryConfig {
  /**
   * Set this true and a search returns the hits the reachable nodes gave,
   * counting the rest in {@link QueryResult.coverage}, which is what a node
   * does by default. Set it false, and a partition that times out or errors on
   * every copy, or that has no active copy, fails the whole search with
   * `QUERY_PARTIAL_FAILURE`.
   */
  allowPartialResults?: boolean
  /**
   * A search waits this many milliseconds for each copy that it asks, and it
   * asks the next in-sync copy of a partition once that wait runs out. The
   * search counts the partition as timed out only when every copy has timed
   * out, and the wait is 5000 milliseconds where you set none.
   */
  partitionTimeout?: number
}

/**
 * How an index is spread across the cluster when a node creates it.
 *
 * @public
 */
export interface CreateIndexOptions {
  /** The cluster splits the index into this many partitions, and into {@link DEFAULT_PARTITION_COUNT} by default. */
  partitionCount?: number
  /**
   * The cluster keeps this many replicas of each partition besides its primary, and
   * {@link DEFAULT_REPLICATION_FACTOR} by default.
   */
  replicationFactor?: number
  /**
   * The creation returns once every partition is in service or once this many milliseconds have passed, which is
   * 30000 where you name none. It returns either way, so a write sent after the deadline may be refused with
   * `QUERY_ROUTING_FAILED` while the controller is still allocating. Pass 0 to return as soon as the schema is
   * published.
   */
  waitForServingMs?: number
}

/**
 * Where a node stands between starting and shutting down, which is what a
 * readiness probe reads.
 *
 * A node reports `STARTING` until it holds a registration. It reports
 * `JOINING` while it bootstraps a partition the controller gave it, and
 * `SERVING` once it serves every one of them. It reports `LEAVING` from the
 * moment shutdown begins.
 *
 * @public
 */
export type NodeReadiness = 'STARTING' | 'JOINING' | 'SERVING' | 'LEAVING'

/**
 * The cluster-facing side of a node, which is where you look at the cluster
 * rather than at the data.
 *
 * @public
 */
export interface ClusterNamespace {
  /**
   * Reads how one index is spread across the cluster.
   *
   * @param indexName - The index to describe.
   * @returns Its allocation, or `null` when the index has none yet.
   */
  getAllocation(indexName: string): Promise<AllocationTable | null>
  /**
   * Describes this node.
   *
   * @returns Its id, its roles, and where it stands.
   */
  getNodeInfo(): ClusterNodeInfo
  /**
   * Reports whether this node is the cluster's active controller, which is the
   * one node making allocation decisions.
   *
   * @returns True while this node holds the controller lease.
   */
  isControllerActive(): boolean
  /**
   * Reports whether this node serves work, which is what a readiness probe
   * answers with.
   *
   * @returns The node's readiness as it stands.
   */
  getReadiness(): NodeReadiness
  /**
   * Lists the nodes the coordinator holds a registration for.
   *
   * @returns One registration per node, as each node published it.
   */
  listNodes(): Promise<NodeRegistration[]>
  /**
   * Names the node holding the controller lease.
   *
   * @returns Its id, or `null` while no node holds the lease.
   */
  getControllerNodeId(): Promise<string | null>
  /**
   * Changes how many replicas besides its primary each partition of an index keeps.
   *
   * The node sends the change to the active controller, which stores the factor in the index metadata and writes an
   * allocation table that carries it before this call returns. A higher factor adds replicas, and each new copy
   * catches up from its primary. A lower factor removes the surplus replicas, lagging ones first, and never the
   * primary.
   *
   * @param indexName - The index to change.
   * @param replicationFactor - The number of replicas besides the primary, an integer from 0 to 255.
   * @returns A promise that settles once the controller has stored the factor and written the table.
   * @throws A `NarsilError` with `CONFIG_INVALID` for a factor outside that range, with `INDEX_NOT_FOUND` where the
   * cluster holds no index of that name, and with `NODE_NOT_CONTROLLER` while no node holds the controller lease.
   */
  setReplicationFactor(indexName: string, replicationFactor: number): Promise<void>
  /**
   * Reports how well the cluster holds each index, from the allocation tables in the coordinator.
   *
   * @returns The status of each index and the worst of them as the status of the cluster.
   */
  getHealth(): Promise<ClusterHealth>
  /**
   * Reports the replication lag and the live commit point of each partition that this node leads, the stored commit
   * point floor and in-sync replica count of every partition in the cluster, and the timing of this node's
   * coordinator calls.
   *
   * @returns The figures as they stand when the call reads them.
   */
  getMetrics(): Promise<ClusterMetrics>
}

/**
 * What one node reports about itself.
 *
 * @public
 */
export interface ClusterNodeInfo {
  /** This identifies the node across the cluster. */
  nodeId: string
  /** The node holds these roles in the cluster. */
  roles: ReadonlyArray<NodeRole>
  /** This says where the node stands, from joining through to shut down. */
  status: string
}

export interface ClusterNodeDeps {
  nodeId: string
  roles: ReadonlyArray<NodeRole>
  coordinator: ClusterCoordinator
  transport: NodeTransport
  engine: Narsil
  address: string
}
