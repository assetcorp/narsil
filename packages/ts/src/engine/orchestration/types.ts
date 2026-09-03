import type { FanOutResult } from '../../partitioning/fan-out'
import type { EmbeddingAdapter } from '../../types/adapters'
import type { NarsilConfig } from '../../types/config'
import type { GlobalStatistics } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { MemoryStats, WorkerCopyReport } from '../../types/results'
import type { IndexConfig } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import type { DirectExecutorExtensions } from '../../workers/direct-executor'
import type { Executor } from '../../workers/executor'
import type { WorkerPool } from '../../workers/pool'
import type { WorkerAction } from '../../workers/protocol'
import type { BuiltSegment, SegmentBuildRequest } from './segments'

export interface WorkerOrchestrator {
  scaleOutReadyIndexes(): Promise<void>
  scaleOutBeforeBatch(indexName: string, incomingCount: number): Promise<void>
  replicateToWorkers(action: WorkerAction): Promise<void>
  awaitReplication(indexName?: string): Promise<void>
  awaitCompactions(): Promise<void>
  openIndex(indexName: string): Promise<void>
  closeIndex(indexName: string): Promise<void>
  isIndexBusy(indexName: string): boolean
  buildSegments(requests: SegmentBuildRequest[]): Promise<BuiltSegment[] | null>
  segmentBuildConcurrency(indexName: string): number
  searchViaWorker(
    indexName: string,
    params: QueryParams,
    globalStats?: GlobalStatistics,
    partitionIds?: number[],
  ): Promise<FanOutResult | null>
  hasWorkerPool(): boolean
  desyncIndex(indexName: string): boolean
  resyncIndex(indexName: string, wasScaledOut: boolean): Promise<void>
  noteAccess(indexName: string): void
  workerCopies(): WorkerCopyReport[]
  getWorkerMemoryStats(): Promise<MemoryStats['workers']>
  shutdown(): Promise<void>
}

export interface WorkerOrchestratorCallbacks {
  onCopiesLoaded?: (workerCount: number, reason: string) => void
  onCopyLoadFailure?: (reason: string, error: Error, retryable: boolean) => void
  onWorkerCrash?: (workerId: number, indexNames: string[], error: Error) => void
  shouldDeferCopies?: () => boolean
}

export type IndexRegistry = Map<
  string,
  { config: IndexConfig; language: LanguageModule; embeddingAdapter: EmbeddingAdapter | null }
>

export interface ReplicationQueue {
  tail: Promise<void>
  pendingActions: number
  pendingDocuments: number
}

export interface SegmentLedgerEntry {
  segmentId: string
  documentCount: number
}

export type CopyTransitionKind = 'load' | 'reload' | 'drop'

export interface CopyTransition {
  readonly kind: CopyTransitionKind
  readonly done: Promise<void>
}

export interface OrchestratorState {
  readonly config: NarsilConfig | undefined
  readonly executor: Executor & DirectExecutorExtensions
  readonly indexRegistry: IndexRegistry
  readonly callbacks: WorkerOrchestratorCallbacks | undefined
  readonly workersEnabled: boolean
  readonly keywordWorkerCount: number
  readonly copyThreshold: number
  readonly copyIdleTimeoutMs: number
  readonly bootstrapModule: string | undefined
  readonly reportedIneligible: Set<string>
  readonly scaledOutIndexes: Set<string>
  readonly desyncedIndexes: Set<string>
  readonly copyLoadBuffers: Map<string, WorkerAction[]>
  readonly copyTransitions: Map<string, CopyTransition>
  readonly droppedCopies: Map<string, string>
  readonly lastAccessAt: Map<string, number>
  readonly copyReloadCounts: Map<string, number>
  readonly replicationQueues: Map<string, ReplicationQueue>
  readonly segmentLedger: Map<string, Map<number, SegmentLedgerEntry[]>>
  readonly compactionsInFlight: Map<string, Promise<void>>
  readonly idleMergeTimers: Map<string, ReturnType<typeof setTimeout>>
  workerPool: WorkerPool | null
  poolStart: Promise<WorkerPool> | null
  poolRetryAt: number
  poolRetryDelayMs: number
  poolRepair: Promise<void> | null
  repairTimer: ReturnType<typeof setTimeout> | null
  scaleOutBlocked: boolean
  idleSweep: ReturnType<typeof setInterval> | null
}
