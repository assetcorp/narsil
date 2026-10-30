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
  /** A replication entry, or a batch of them, may take this long to reach a replica and come back acknowledged. */
  replicationTimeout: number
  /** A node waits this long for each next chunk of a snapshot transfer, which moves a partition or an index between nodes, so that the node can receive a transfer of any size while the sender keeps sending. */
  snapshotTimeout: number
}

export const DEFAULT_TRANSPORT_CONFIG: TransportConfig = {
  connectTimeout: 5_000,
  requestTimeout: 30_000,
  replicationTimeout: 10_000,
  snapshotTimeout: 300_000,
}

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
  listen(handler: ListenHandler): Promise<() => void>
  /** Closes every connection and releases the port or registration it held. */
  shutdown(): Promise<void>
  /**
   * The timeouts that this transport enforces on each kind of exchange.
   *
   * A node bounds an in-sync removal, and each try to complete a rollback, by
   * the `replicationTimeout` given here, so that both end within the wait that
   * the transport allows a replication entry. A node whose transport leaves
   * this absent uses the defaults, which allow 5,000 ms to connect, 30,000 ms
   * for a request, 10,000 ms for a replication entry, and 300,000 ms for each
   * snapshot chunk.
   */
  readonly timeouts?: TransportConfig
}

/**
 * Sends one reply back to the peer that asked.
 *
 * It settles once the transport has taken the reply, which a transport whose
 * connection is full delays until the connection accepts more. A handler
 * sending many replies awaits each one before it builds the next, so a
 * snapshot cannot outrun a slow receiver and exhaust this node's memory.
 *
 * @param response - The reply to send.
 *
 * @public
 */
export type RespondFn = (response: TransportMessage) => Promise<void>

/**
 * Handles one request a peer sent, replying through `respond`.
 *
 * @public
 */
export type ListenHandler = (message: TransportMessage, respond: RespondFn) => void | Promise<void>

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
  FORWARD_BATCH: 'replication.forward_batch',
  ENTRY: 'replication.entry',
  ENTRY_BATCH: 'replication.entry_batch',
  ACK: 'replication.ack',
  SYNC_REQUEST: 'replication.sync_request',
  SYNC_ENTRIES: 'replication.sync_entries',
  SNAPSHOT_START: 'replication.snapshot_start',
  SNAPSHOT_CHUNK: 'replication.snapshot_chunk',
  SNAPSHOT_END: 'replication.snapshot_end',
  INSYNC_ADD: 'replication.insync_add',
  INSYNC_REMOVE: 'replication.insync_remove',
  INSYNC_CONFIRM: 'replication.insync_confirm',
  PRIMARY_RESIGN: 'replication.primary_resign',
} as const

export const QueryMessageTypes = {
  SEARCH: 'query.search',
  SEARCH_RESULT: 'query.search_result',
  FETCH: 'query.fetch',
  FETCH_RESULT: 'query.fetch_result',
  STATS: 'query.stats',
  STATS_RESULT: 'query.stats_result',
  COUNT: 'query.count',
  COUNT_RESULT: 'query.count_result',
  LIST: 'query.list',
  LIST_RESULT: 'query.list_result',
  SUGGEST: 'query.suggest',
  SUGGEST_RESULT: 'query.suggest_result',
  PREFLIGHT: 'query.preflight',
  PREFLIGHT_RESULT: 'query.preflight_result',
} as const

export const ClusterMessageTypes = {
  PING: 'cluster.ping',
  PONG: 'cluster.pong',
  BOOTSTRAP_COMPLETE: 'cluster.bootstrap_complete',
  PARTITION_STORES: 'cluster.partition_stores',
  REPLICATION_FACTOR: 'cluster.replication_factor',
  REBUILD_ANALYSIS: 'cluster.rebuild_analysis',
  REBALANCE: 'cluster.rebalance',
  RESHARD_START: 'cluster.reshard_start',
  RESHARD_FORWARD: 'cluster.reshard_forward',
  RESHARD_CUTOVER: 'cluster.reshard_cutover',
  RESHARD_PURGE: 'cluster.reshard_purge',
  INDEX_SETTINGS: 'cluster.index_settings',
} as const

export interface WriteCondition {
  ifSeqNo: number
  ifPrimaryTerm: number
  abandonedSeqNo: number
  abandonedPrimaryTerm: number
  compensationSeqNo: number
}

export interface AbandonedWrite {
  seqNo: number
  primaryTerm: number
  compensationSeqNo: number
  previousSeqNo: number
  previousPrimaryTerm: number
}

export interface ForwardPayload extends Partial<WriteCondition> {
  indexName: string
  documentId: string
  operation: 'insert' | 'remove' | 'update'
  document: Uint8Array | null
  updateFields: Record<string, unknown> | null
  indexUuid?: string
}

export interface ForwardBatchOperation extends Partial<WriteCondition> {
  documentId: string
  operation: 'insert' | 'remove' | 'update'
  document: Uint8Array | null
  updateFields: Record<string, unknown> | null
}

export interface ForwardBatchPayload {
  indexName: string
  operations: ForwardBatchOperation[]
  indexUuid?: string
}

export interface ForwardBatchOperationResult {
  documentId: string
  success: boolean
  errorCode: string | null
  errorMessage: string | null
  errorDetails?: Record<string, unknown> | null
  abandonedWrite?: AbandonedWrite
}

export interface ForwardBatchResultPayload {
  results: ForwardBatchOperationResult[]
}

export interface EntryPayload {
  entry: ReplicationLogEntry
  indexUuid?: string
}

export interface EntryBatchPayload {
  entries: ReplicationLogEntry[]
  indexUuid?: string
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
  indexUuid?: string
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

export interface InsyncRemovePayload {
  indexName: string
  partitionId: number
  replicaNodeId: string
  primaryTerm: number
}

export interface InsyncAddPayload {
  indexName: string
  partitionId: number
  replicaNodeId: string
  primaryTerm: number
  appliedSeqNo: number
  commitPoint: number
}

export interface InsyncConfirmPayload {
  indexName: string
  partitionId: number
  accepted: boolean
}

export interface PrimaryResignPayload {
  indexName: string
  indexUuid: string
  partitionId: number
  primaryTerm: number
}

export type {
  BootstrapCompletePayload,
  BootstrapCompleteResultPayload,
  IndexSettingsPayload,
  IndexSettingsResultPayload,
  PartitionStoresPayload,
  PartitionStoresResultPayload,
  PingPayload,
  PongPayload,
  RebuildAnalysisPayload,
  RebuildAnalysisResultPayload,
  ReplicationFactorPayload,
} from './cluster-payloads'
export type {
  CountPayload,
  CountResultPayload,
  FacetBucket,
  FetchDocumentId,
  FetchedDocument,
  FetchPayload,
  FetchResultPayload,
  GlobalStatistics,
  ListEntryWire,
  ListPayload,
  ListResultPayload,
  PartitionCountEntry,
  PartitionSearchResult,
  PreflightPayload,
  PreflightResultPayload,
  ScoredEntry,
  SearchPayload,
  SearchResultPayload,
  SortField,
  StatsExpansionPayload,
  StatsPayload,
  StatsResultPayload,
  SuggestPayload,
  SuggestResultPayload,
  WireFacetField,
  WireFacetRange,
  WireGroupConfig,
  WireGroupEntry,
  WireHighlightConfig,
  WireHybridConfig,
  WirePinnedEntry,
  WireQueryParams,
  WireVectorQueryParams,
} from './query-payloads'
