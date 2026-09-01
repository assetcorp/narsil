import type { NarsilEventMap } from '../../../types/events'
import type {
  BatchResult,
  IndexStats,
  ListResult,
  MemoryStats,
  PartitionStatsResult,
  PreflightResult,
  QueryResult,
  SuggestResult,
} from '../../../types/results'
import type { AnyDocument, IndexConfig, InsertOptions } from '../../../types/schema'
import type { ListParams, QueryParams, SuggestParams } from '../../../types/search'
import type { NodeRole } from '../../coordinator/types'
import type { ClusterNamespace, CreateIndexOptions } from './config'

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
   * Loads this node's local copy of an index from durable storage.
   *
   * @param indexName - The index to load on this node.
   * @returns A promise that settles when the local copy is ready for operations.
   */
  open(indexName: string): Promise<void>
  /**
   * Checkpoints and releases this node's local copy of an index.
   *
   * @param indexName - The index to close on this node.
   * @returns A promise that settles after the local copy releases its memory.
   */
  close(indexName: string): Promise<void>

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
   * @param options - Setting `skipClone` stores the object you passed rather
   * than a copy, and it applies only where this node is the partition's own
   * primary, because a document sent to another node is encoded for the wire
   * and decoded there.
   * @returns The id the document is stored under.
   */
  insert(indexName: string, document: AnyDocument, docId?: string, options?: InsertOptions): Promise<string>
  /**
   * Adds many documents, routing each to its own partition's primary, and
   * reports each one's outcome.
   *
   * @param indexName - The index that receives the documents.
   * @param documents - The documents to write.
   * @param options - Setting `skipClone` stores the objects you passed rather
   * than copies, and it applies only to the documents this node is primary
   * for, because the rest are encoded for the wire.
   * @returns The ids written, and each rejection with its error.
   */
  insertBatch(indexName: string, documents: AnyDocument[], options?: InsertOptions): Promise<BatchResult>
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
