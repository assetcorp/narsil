import type { ReplicationLogEntry } from '../replication/types'

export interface TransportMessage {
  type: string
  sourceId: string
  requestId: string
  payload: Uint8Array
}

export interface TransportConfig {
  connectTimeout: number
  requestTimeout: number
  replicationTimeout: number
  snapshotTimeout: number
}

export const DEFAULT_TRANSPORT_CONFIG: TransportConfig = {
  connectTimeout: 5_000,
  requestTimeout: 30_000,
  replicationTimeout: 10_000,
  snapshotTimeout: 300_000,
}

export const MAX_MESSAGE_SIZE_BYTES = 67_108_864

export interface NodeTransport {
  send(target: string, message: TransportMessage): Promise<TransportMessage>
  stream(target: string, message: TransportMessage, handler: (chunk: Uint8Array) => void): Promise<void>
  listen(handler: (message: TransportMessage, respond: (response: TransportMessage) => void) => void): Promise<void>
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
  k: number
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
  limit: number
  offset: number
  searchAfter: string | null
  fields: string[] | null
  boost: Record<string, number> | null
  tolerance: number | null
  threshold: number | null
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
  score: number
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
