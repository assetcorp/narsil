import type { NarsilConfig } from '../../../types/config'
import type { AllocationTable, ClusterCoordinator, NodeCapacity, NodeRole } from '../../coordinator/types'
import type { ReplicationConfig } from '../../replication/types'
import type { NodeTransport } from '../../transport/types'

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
  /** This identifies the node across the cluster. The package generates an id by default, which a restart changes. */
  nodeId?: string
  /** This node offers this much capacity, which the allocator weighs. It offers {@link DEFAULT_CAPACITY} by default. */
  capacity?: NodeCapacity
  /** These settings configure the engine this node runs locally, such as its persistence and durability. */
  engine?: NarsilConfig
  /** These replication settings override the engine's own, and anything you leave out keeps its value. */
  replication?: Partial<ReplicationConfig>
  /** These settings govern how this node gathers each search from the cluster, and anything you leave out keeps its default. */
  query?: ClusterQueryConfig
  /** These settings govern how this node stands for controller election, and anything you leave out keeps its default. */
  controller?: ClusterControllerConfig
  /** This receives the failures the node reports while running on its own, away from any call you made. */
  onError?: (error: Error) => void
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
   * does by default. Set it false and one partition that times out, errors, or
   * has no active copy fails the whole search with `QUERY_PARTIAL_FAILURE`.
   */
  allowPartialResults?: boolean
  /** A search waits this many milliseconds for each node before it counts that node's partitions as timed out, which is 5000 milliseconds where you name none. */
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
  /** The cluster keeps this many copies of each partition, and {@link DEFAULT_REPLICATION_FACTOR} by default. */
  replicationFactor?: number
}

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

/**
 * One node of a cluster, which routes each write to the partition's primary
 * and gathers each search from every partition.
 *
 * The write and search methods mirror {@link Narsil}, so code moving from a
 * single engine to a cluster keeps its shape. Build one with
 * {@link createClusterNode}.
 *
 * @public
 */
