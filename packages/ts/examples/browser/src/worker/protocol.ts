import type {
  AnyDocument,
  IndexInfo,
  IndexStats,
  ListParams,
  ListResult,
  MemoryStats,
  PartitionConfig,
  PartitionStatsResult,
  PreflightResult,
  QueryParams,
  QueryResult,
  SuggestParams,
  SuggestResult,
  SynonymRule,
  VectorMaintenanceResult,
} from '@delali/narsil'
import type { AnalysisChangeRequest, DatasetLoadProgress, LoadDatasetRequest } from '@delali/narsil-example-shared'

export interface QueryExtras {
  groupTotalField: string | null
}

export interface SyncStartRequest {
  indexName: string
  serverUrl: string
  grantUrl: string
  deviceKey?: string
}

export interface DeviceSyncView {
  indexName: string
  serverUrl: string
  connection: 'connected' | 'connecting' | 'stopped'
  queuedWrites: number
  epoch: string | null
  serverPosition: number | null
  lastError: string | null
  refusedWrites: number
}

export interface WorkerCallMap {
  loadDataset: { args: [LoadDatasetRequest]; result: IndexInfo[] }
  query: { args: [string, QueryParams, QueryExtras]; result: QueryResult }
  preflight: { args: [string, QueryParams]; result: PreflightResult }
  suggest: { args: [string, SuggestParams]; result: SuggestResult }
  listDocuments: { args: [string, ListParams]; result: ListResult }
  getDocument: { args: [string, string]; result: AnyDocument | null }
  saveDocument: { args: [string, string, AnyDocument]; result: null }
  removeDocument: { args: [string, string]; result: null }
  getStats: { args: [string]; result: IndexStats }
  getPartitionStats: { args: [string]; result: PartitionStatsResult[] }
  getMemoryStats: { args: []; result: MemoryStats }
  vectorMaintenanceStatus: { args: [string]; result: VectorMaintenanceResult[] }
  listIndexes: { args: []; result: IndexInfo[] }
  dropIndex: { args: [string]; result: null }
  getSynonyms: { args: [string]; result: SynonymRule[] }
  updateSynonyms: { args: [string, SynonymRule[]]; result: null }
  changeAnalysis: { args: [string, AnalysisChangeRequest]; result: null }
  rebalance: { args: [string, number]; result: null }
  updatePartitionConfig: { args: [string, Partial<PartitionConfig>]; result: null }
  compactVectors: { args: [string]; result: null }
  optimizeVectors: { args: [string]; result: null }
  snapshot: { args: [string]; result: Uint8Array<ArrayBuffer> }
  restore: { args: [string, Uint8Array<ArrayBuffer>]; result: null }
  exportDocuments: { args: [string]; result: Uint8Array<ArrayBuffer> }
  importDocumentExport: { args: [string, Uint8Array<ArrayBuffer>]; result: null }
  startSync: { args: [SyncStartRequest]; result: DeviceSyncView[] }
  stopSync: { args: [string]; result: DeviceSyncView[] }
  syncStatus: { args: []; result: DeviceSyncView[] }
  openNotes: { args: [SyncStartRequest]; result: DeviceSyncView[] }
  pauseSync: { args: [string, boolean]; result: DeviceSyncView[] }
}

export type WorkerMethod = keyof WorkerCallMap

export type WorkerArgs<K extends WorkerMethod> = WorkerCallMap[K]['args']

export type WorkerResult<K extends WorkerMethod> = WorkerCallMap[K]['result']

export interface WorkerRequest<K extends WorkerMethod = WorkerMethod> {
  id: string
  method: K
  args: WorkerArgs<K>
}

export type WorkerReply =
  | { kind: 'result'; id: string; result: unknown }
  | { kind: 'failure'; id: string; code: string; message: string; details: Record<string, unknown> }

export interface WorkerProgressEvent {
  kind: 'progress'
  progress: DatasetLoadProgress
}

export interface WorkerChangeEvent {
  kind: 'changed'
  indexName: string
}

export type WorkerOutbound = WorkerReply | WorkerProgressEvent | WorkerChangeEvent

export function transferableBuffersIn(values: readonly unknown[]): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>()
  for (const value of values) {
    if (!(value instanceof Uint8Array)) continue
    const { buffer } = value
    if (buffer instanceof ArrayBuffer && value.byteOffset === 0 && value.byteLength === buffer.byteLength) {
      buffers.add(buffer)
    }
  }
  return [...buffers]
}
