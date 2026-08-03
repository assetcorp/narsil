import type { Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import type { BatchResult, QueryResult } from '../../types/results'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import type { AllocationTable, ClusterCoordinator, NodeCapacity, NodeRole } from '../coordinator/types'
import type { ReplicationConfig } from '../replication/types'
import type { NodeTransport } from '../transport/types'

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
  /** This receives the failures the node reports while running on its own, away from any call you made. */
  onError?: (error: Error) => void
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
export interface ClusterNode {
  /** This identifies the node across the cluster. */
  readonly nodeId: string
  /** The node holds these roles in the cluster. */
  readonly roles: ReadonlyArray<NodeRole>

  /**
   * Creates an index across the cluster, publishing its schema and allocating
   * its partitions to nodes.
   *
   * @param name - Every later call uses this name to reach the index.
   * @param config - The schema, and the language, scoring, and vector
   * settings, exactly as a single engine takes them.
   * @param options - How the index is spread across the cluster.
   */
  createIndex(name: string, config: IndexConfig, options?: CreateIndexOptions): Promise<void>
  /**
   * Adds one document, routing it to the partition's primary.
   *
   * @param indexName - The index that receives the document.
   * @param document - Its fields must match the types the schema declares.
   * @param docId - Pass an id to control it yourself, or omit it and read the
   * returned value.
   * @returns The id the document is stored under.
   */
  insert(indexName: string, document: AnyDocument, docId?: string): Promise<string>
  /**
   * Adds many documents, routing each to its own partition's primary, and
   * reports each one's outcome.
   *
   * @param indexName - The index that receives the documents.
   * @param documents - The documents to write.
   * @returns The ids written, and each rejection with its error.
   */
  insertBatch(indexName: string, documents: AnyDocument[]): Promise<BatchResult>
  /**
   * Removes one document.
   *
   * @param indexName - The index holding the document.
   * @param docId - The document to remove.
   */
  remove(indexName: string, docId: string): Promise<void>
  /**
   * Removes many documents and reports each one's outcome.
   *
   * @param indexName - The index holding the documents.
   * @param docIds - The documents to remove.
   * @returns The ids removed, and each failure with its error.
   */
  removeBatch(indexName: string, docIds: string[]): Promise<BatchResult>
  /**
   * Runs a search across every partition and merges the results into one
   * ranking.
   *
   * The search skips a partition whose nodes are all unreachable instead of
   * failing, so read the result's count against what you expect.
   *
   * @typeParam T - Shape of the stored documents.
   * @param indexName - The index the search runs against.
   * @param params - The same parameters a single engine takes.
   * @returns The merged hits, the total count, and the elapsed time.
   */
  query<T = AnyDocument>(indexName: string, params: QueryParams): Promise<QueryResult<T>>

  /** This reaches the cluster-facing side of the node. */
  cluster: ClusterNamespace

  /** Joins the cluster: the node registers, takes on its allocated partitions, and starts serving. */
  start(): Promise<void>
  /** Leaves the cluster: the node hands its partitions on, deregisters, and closes the engine it ran. */
  shutdown(): Promise<void>
}

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
