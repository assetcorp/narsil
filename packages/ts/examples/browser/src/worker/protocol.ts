import type {
  IndexInfo,
  IndexStats,
  ListParams,
  ListResult,
  MemoryStats,
  PartitionStatsResult,
  QueryParams,
  QueryResult,
  SuggestParams,
  SuggestResult,
  VectorMaintenanceResult,
} from '@delali/narsil'
import type { DatasetLoadProgress, LoadDatasetRequest } from '@delali/narsil-example-shared'

export interface WorkerCallMap {
  loadDataset: { args: [LoadDatasetRequest]; result: IndexInfo[] }
  query: { args: [string, QueryParams]; result: QueryResult }
  suggest: { args: [string, SuggestParams]; result: SuggestResult }
  listDocuments: { args: [string, ListParams]; result: ListResult }
  getStats: { args: [string]; result: IndexStats }
  getPartitionStats: { args: [string]; result: PartitionStatsResult[] }
  getMemoryStats: { args: []; result: MemoryStats }
  vectorMaintenanceStatus: { args: [string]; result: VectorMaintenanceResult[] }
  listIndexes: { args: []; result: IndexInfo[] }
  dropIndex: { args: [string]; result: null }
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
  | { kind: 'failure'; id: string; code: string; message: string }

export interface WorkerProgressEvent {
  kind: 'progress'
  progress: DatasetLoadProgress
}

export type WorkerOutbound = WorkerReply | WorkerProgressEvent
