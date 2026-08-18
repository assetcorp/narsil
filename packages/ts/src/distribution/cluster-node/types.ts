import type { Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import type { NarsilEventMap } from '../../types/events'
import type {
  BatchResult,
  IndexStats,
  ListResult,
  MemoryStats,
  PartitionStatsResult,
  PreflightResult,
  QueryResult,
  SuggestResult,
} from '../../types/results'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import type { ListParams, QueryParams, SuggestParams } from '../../types/search'
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
   * Replaces a stored document, routing the replacement to the partition's
   * primary, which replicates the complete new document to every in-sync copy.
   *
   * @param indexName - The index holding the document.
   * @param docId - The document to replace.
   * @param document - The complete replacement, because the primary replicates
   * whole documents rather than changed fields.
   */
  update(indexName: string, docId: string, document: AnyDocument): Promise<void>
  /**
   * Replaces many documents, routing each to its own partition's primary, and
   * reports each one's outcome. Replacements bound for one remote primary
   * travel together in one message.
   *
   * @param indexName - The index holding the documents.
   * @param updates - Each id with the complete document that replaces it.
   * @returns The ids replaced, and each failure with its error.
   */
  updateBatch(indexName: string, updates: Array<{ docId: string; document: AnyDocument }>): Promise<BatchResult>
  /**
   * Removes an index from the whole cluster: its schema, its allocation, and
   * every node's local copy. The documents do not come back.
   *
   * The controller drives the teardown, so nodes drop their partitions a
   * moment after this resolves rather than atomically with it.
   *
   * @param name - The index to drop.
   */
  dropIndex(name: string): Promise<void>
  /**
   * Removes every document from an index across the cluster and keeps the
   * index itself, along with its schema and allocation.
   *
   * Each removal runs through the replication log the way a single remove
   * does, so a large index takes many round trips to empty.
   *
   * @param indexName - The index to empty.
   */
  clear(indexName: string): Promise<void>
  /**
   * Counts the documents an index holds across the cluster, reading each
   * partition's count from one copy.
   *
   * The count fails with `QUERY_NO_ACTIVE_REPLICA` rather than answer with a
   * partition missing, because a partial count would read as a smaller index.
   *
   * @param indexName - The index to count.
   * @returns The document count across every partition.
   */
  countDocuments(indexName: string): Promise<number>
  /**
   * Reads one page of stored documents from across the cluster, in
   * document-id order by default and in the caller's sort order when they
   * name one. Pass the returned cursor back for the next page.
   *
   * @typeParam T - Shape of the stored documents.
   * @param indexName - The index to walk.
   * @param params - These set the cursor, the page size, the filter, the
   * sort, and how much of each document comes back.
   * @returns The page, the cursor for the next page, and how many documents
   * the listing covers in total.
   */
  listDocuments<T = AnyDocument>(indexName: string, params?: ListParams): Promise<ListResult<T>>
  /**
   * Returns the indexed terms that complete a prefix, merged from every
   * partition with their document frequencies summed.
   *
   * Each node reports its most frequent completions alone, so a term that
   * ranks low on every node can be undercounted, exactly as distributed
   * facet counts can.
   *
   * @param indexName - The index to draw completions from.
   * @param params - The prefix typed so far, and how many completions to return.
   * @returns The completions, most widely used first.
   */
  suggest(indexName: string, params: SuggestParams): Promise<SuggestResult>
  /**
   * Counts what a query would match across the cluster without building a
   * single hit.
   *
   * @param indexName - The index the query would run against.
   * @param params - The same parameters {@link ClusterNode.query} takes.
   * @returns The match count and the time the count took.
   */
  preflight(indexName: string, params: QueryParams): Promise<PreflightResult>
  /**
   * Describes one index across the cluster: its document count and memory
   * estimate summed over every partition, its partition count, its language,
   * and its schema.
   *
   * @param indexName - The index to describe.
   * @returns The index's current figures, gathered from one copy of each partition.
   */
  getStats(indexName: string): Promise<IndexStats>
  /**
   * Returns per-partition figures for one index, each read from one copy of
   * that partition.
   *
   * @param indexName - The index to describe.
   * @returns One entry per partition, in partition order.
   */
  getPartitionStats(indexName: string): Promise<PartitionStatsResult[]>
  /**
   * Writes this node's local engine state to its durability directory, so a
   * restart of this node replays less of the log. Other nodes checkpoint
   * themselves.
   *
   * @param indexName - The index to checkpoint on this node.
   */
  checkpoint(indexName: string): Promise<void>
  /**
   * Reports what this node's engine and process are using. Memory is a
   * per-node fact, so ask each node for its own.
   *
   * @returns Process heap figures and this node's engine estimate.
   */
  getMemoryStats(): Promise<MemoryStats>
  /**
   * Starts delivering one kind of engine event from this node's local engine
   * to your listener.
   *
   * @typeParam K - The event name, which fixes the payload the listener gets.
   * @param event - Which event to listen for.
   * @param handler - Called once per event on this node.
   */
  on<K extends keyof NarsilEventMap>(event: K, handler: (payload: NarsilEventMap[K]) => void): void
  /**
   * Removes a listener {@link ClusterNode.on} registered.
   *
   * @typeParam K - The event name.
   * @param event - The event the listener was registered for.
   * @param handler - The same function reference that was registered.
   */
  off<K extends keyof NarsilEventMap>(event: K, handler: (payload: NarsilEventMap[K]) => void): void
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
  /**
   * Reads one document, from this node when it holds the partition and from a
   * node that does otherwise.
   *
   * A read fails with `QUERY_NO_ACTIVE_REPLICA` when no reachable node serves
   * the document's partition, rather than reporting the document missing.
   *
   * @param indexName - The index holding the document.
   * @param docId - The document to read.
   * @returns The document, or `undefined` when the partition holds no
   * document under this id.
   */
  get(indexName: string, docId: string): Promise<AnyDocument | undefined>
  /**
   * Reads many documents, grouping the ids by the node that serves each
   * partition and fetching every group in one round trip.
   *
   * The read fails with `QUERY_NO_ACTIVE_REPLICA` when no reachable node
   * serves some document's partition, rather than leaving that document out.
   *
   * @param indexName - The index holding the documents.
   * @param docIds - The documents to read.
   * @returns The documents found, keyed by id; an id nothing is stored under
   * is absent.
   */
  getMultiple(indexName: string, docIds: string[]): Promise<Map<string, AnyDocument>>
  /**
   * Reports whether a document exists, reading through the same routing as
   * {@link ClusterNode.get}.
   *
   * @param indexName - The index to check.
   * @param docId - The document id to check.
   * @returns True when a node serving the partition holds the document.
   */
  has(indexName: string, docId: string): Promise<boolean>

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
