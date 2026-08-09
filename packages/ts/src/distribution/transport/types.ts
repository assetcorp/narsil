import type { ReplicationLogEntry } from '../replication/types'

/**
 * One message on the wire between cluster nodes.
 *
 * The payload is opaque bytes, which is what lets a node written in another
 * language join the same cluster: only the header fields have to agree.
 *
 * @public
 */
export interface TransportMessage {
  /** This says what the message is, such as a replication entry or a search request. */
  type: string
  /** This node sent the message. */
  sourceId: string
  /** This correlates a reply with its request. */
  requestId: string
  /** This carries the encoded body, and the message type tells a reader how to decode it. */
  payload: Uint8Array
}

/**
 * How long a transport waits before giving up on each kind of exchange.
 *
 * Every value is in milliseconds. Replication and snapshot transfers carry
 * their own timeouts because they move far more than a search does.
 *
 * @public
 */
export interface TransportConfig {
  /** Opening a connection to a peer may take this long. */
  connectTimeout: number
  /** An ordinary request and its reply may take this long. */
  requestTimeout: number
  /** A replication entry may take this long to reach a replica and come back acknowledged. */
  replicationTimeout: number
  /** A whole snapshot transfer, which moves a partition between nodes, may take this long. */
  snapshotTimeout: number
}

export const DEFAULT_TRANSPORT_CONFIG: TransportConfig = {
  connectTimeout: 5_000,
  requestTimeout: 30_000,
  replicationTimeout: 10_000,
  snapshotTimeout: 300_000,
}

export const MAX_MESSAGE_SIZE_BYTES = 67_108_864

/**
 * How one cluster node reaches the others.
 *
 * The package includes a TCP transport for real deployments and an in-process
 * one for tests, and this is the contract either satisfies. Write your own to
 * run a cluster over something else.
 *
 * @public
 */
export interface NodeTransport {
  /**
   * Sends one request to a peer and waits for its reply.
   *
   * @param target - Node id to send to.
   * @param message - The request.
   * @returns The peer's reply.
   * @throws A `TransportError` when the peer is unreachable, the message is
   * oversized, or the request times out.
   */
  send(target: string, message: TransportMessage): Promise<TransportMessage>
  /**
   * Sends one request whose reply arrives in chunks, which is how a snapshot
   * moves without being held in memory whole.
   *
   * @param target - Node id to send to.
   * @param message - The request.
   * @param handler - Called once per chunk, in order.
   */
  stream(target: string, message: TransportMessage, handler: (chunk: Uint8Array) => void): Promise<void>
  /**
   * Starts accepting requests from peers.
   *
   * @param handler - Called for each request, with the function that returns
   * the reply.
   * @returns A function that ends the listener.
   */
  listen(
    handler: (message: TransportMessage, respond: (response: TransportMessage) => void) => void | Promise<void>,
  ): Promise<() => void>
  /** Closes every connection and releases the port or registration it held. */
  shutdown(): Promise<void>
}

export const TransportErrorCodes = {
  CONNECT_FAILED: 'TRANSPORT_CONNECT_FAILED',
  TIMEOUT: 'TRANSPORT_TIMEOUT',
  MESSAGE_TOO_LARGE: 'TRANSPORT_MESSAGE_TOO_LARGE',
  DECODE_FAILED: 'TRANSPORT_DECODE_FAILED',
  PEER_UNAVAILABLE: 'TRANSPORT_PEER_UNAVAILABLE',
} as const

export type TransportErrorCode = (typeof TransportErrorCodes)[keyof typeof TransportErrorCodes]

export class TransportError extends Error {
  readonly code: TransportErrorCode
  readonly details: Record<string, unknown>

  constructor(code: TransportErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'TransportError'
    this.code = code
    this.details = details ?? {}
  }
}

export const ReplicationMessageTypes = {
  FORWARD: 'replication.forward',
  ENTRY: 'replication.entry',
  ACK: 'replication.ack',
  SYNC_REQUEST: 'replication.sync_request',
  SYNC_ENTRIES: 'replication.sync_entries',
  SNAPSHOT_START: 'replication.snapshot_start',
  SNAPSHOT_CHUNK: 'replication.snapshot_chunk',
  SNAPSHOT_END: 'replication.snapshot_end',
  SNAPSHOT_SYNC_REQUEST: 'replication.snapshot_sync_request',
  INSYNC_REMOVE: 'replication.insync_remove',
  INSYNC_CONFIRM: 'replication.insync_confirm',
} as const

export const QueryMessageTypes = {
  SEARCH: 'query.search',
  SEARCH_RESULT: 'query.search_result',
  FETCH: 'query.fetch',
  FETCH_RESULT: 'query.fetch_result',
  STATS: 'query.stats',
  STATS_RESULT: 'query.stats_result',
} as const

export const ClusterMessageTypes = {
  PING: 'cluster.ping',
  PONG: 'cluster.pong',
  BOOTSTRAP_COMPLETE: 'cluster.bootstrap_complete',
} as const

export interface ForwardPayload {
  indexName: string
  documentId: string
  operation: 'insert' | 'remove' | 'update'
  document: Uint8Array | null
  updateFields: Record<string, unknown> | null
}

export interface EntryPayload {
  entry: ReplicationLogEntry
}

export interface AckPayload {
  seqNo: number
  partitionId: number
  indexName: string
}

export interface SyncRequestPayload {
  indexName: string
  partitionId: number
  lastSeqNo: number
  lastPrimaryTerm: number
}

export interface SyncEntriesPayload {
  entries: ReplicationLogEntry[]
  isLast: boolean
}

export interface ReplicationSnapshotHeader {
  lastSeqNo: number
  primaryTerm: number
  partitionId: number
  indexName: string
  checksum: number
}

export interface SnapshotStartPayload {
  header: ReplicationSnapshotHeader
  totalBytes: number
}

export interface SnapshotChunkPayload {
  partitionId: number
  indexName: string
  offset: number
  data: Uint8Array
}

export interface SnapshotEndPayload {
  partitionId: number
  indexName: string
  totalBytes: number
  checksum: number
}

export interface SnapshotSyncRequestPayload {
  indexName: string
  partitionId?: number | null
}

export interface InsyncRemovePayload {
  indexName: string
  partitionId: number
  replicaNodeId: string
  primaryTerm: number
}

export interface InsyncConfirmPayload {
  indexName: string
  partitionId: number
  accepted: boolean
}

export interface SortField {
  field: string
  direction: 'asc' | 'desc'
}

export interface WireGroupConfig {
  field: string
  maxPerGroup: number
}

export interface WireVectorQueryParams {
  field: string
  value: number[] | null
  text: string | null
  similarity: number | null
}

export interface WireHybridConfig {
  strategy: 'rrf' | 'linear'
  k: number
  alpha: number
}

export interface WireQueryParams {
  term: string | null
  filters: Record<string, unknown> | null
  sort: SortField[] | null
  group: WireGroupConfig | null
  facets: string[] | null
  facetSize: number | null
  limit: number
  offset: number
  searchAfter: string | null
  fields: string[] | null
  boost: Record<string, number> | null
  tolerance: number | null
  threshold: number | null
  includeScores: boolean | null
  scoring: 'local' | 'dfs' | 'broadcast'
  vector: WireVectorQueryParams | null
  hybrid: WireHybridConfig | null
}

export interface GlobalStatistics {
  totalDocuments: number
  docFrequencies: Record<string, number>
  totalFieldLengths: Record<string, number>
  averageFieldLengths: Record<string, number>
}

export interface WireHighlightConfig {
  fields: string[] | null
  before: string
  after: string
  maxSnippetLength: number
}

export interface ScoredEntry {
  docId: string
  score: number | null
  sortValues: unknown[] | null
}

export interface FacetBucket {
  value: string
  count: number
}

export interface PartitionSearchResult {
  partitionId: number
  scored: ScoredEntry[]
  totalHits: number
}

export interface SearchPayload {
  indexName: string
  partitionIds: number[]
  params: WireQueryParams
  globalStats: GlobalStatistics | null
  facetShardSize: number | null
}

export interface SearchResultPayload {
  results: PartitionSearchResult[]
  facets: Record<string, FacetBucket[]> | null
}

export interface FetchDocumentId {
  docId: string
  partitionId: number
}

export interface FetchPayload {
  indexName: string
  documentIds: FetchDocumentId[]
  fields: string[] | null
  highlight: WireHighlightConfig | null
}

export interface FetchedDocument {
  docId: string
  document: Record<string, unknown>
  highlights: Record<string, string[]> | null
}

export interface FetchResultPayload {
  documents: FetchedDocument[]
}

export interface StatsPayload {
  indexName: string
  partitionIds: number[]
  terms: string[]
}

export interface StatsResultPayload {
  totalDocuments: number
  docFrequencies: Record<string, number>
  totalFieldLengths: Record<string, number>
}

export interface PingPayload {
  timestamp: number
}

export interface PongPayload {
  timestamp: number
  respondedAt: number
}

export interface BootstrapCompletePayload {
  indexName: string
  partitionId: number
  nodeId: string
  primaryTerm: number
}

export interface BootstrapCompleteResultPayload {
  indexName: string
  partitionId: number
  accepted: boolean
}
