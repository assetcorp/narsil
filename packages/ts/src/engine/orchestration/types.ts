import type { FanOutResult } from '../../partitioning/fan-out'
import type { EmbeddingAdapter } from '../../types/adapters'
import type { NarsilConfig } from '../../types/config'
import type { GlobalStatistics } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { MemoryStats } from '../../types/results'
import type { IndexConfig } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import type { DirectExecutorExtensions } from '../../workers/direct-executor'
import type { Executor } from '../../workers/executor'
import type { WorkerPool } from '../../workers/pool'
import type { ExecutionPromoter } from '../../workers/promoter'
import type { WorkerAction } from '../../workers/protocol'
import type { BuiltSegment, SegmentBuildRequest } from './segments'

export interface WorkerOrchestrator {
  checkPromotion(): Promise<void>
  promoteBeforeBatch(indexName: string, incomingCount: number): Promise<void>
  replicateToWorkers(action: WorkerAction): Promise<void>
  awaitReplication(indexName?: string): Promise<void>
  awaitCompactions(): Promise<void>
  buildSegments(requests: SegmentBuildRequest[]): Promise<BuiltSegment[] | null>
  segmentBuildConcurrency(indexName: string): number
  searchViaWorker(indexName: string, params: QueryParams, globalStats?: GlobalStatistics): Promise<FanOutResult | null>
  isPromoted(): boolean
  desyncIndex(indexName: string): boolean
  resyncIndex(indexName: string, wasPromoted: boolean): Promise<void>
  getWorkerMemoryStats(): Promise<MemoryStats['workers']>
  shutdown(): Promise<void>
}

export interface WorkerOrchestratorCallbacks {
  onPromotion?: (workerCount: number, reason: string) => void
  onPromotionFailure?: (reason: string, error: Error, retryable: boolean) => void
  shouldDeferPromotion?: () => boolean
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

export interface OrchestratorState {
  readonly config: NarsilConfig | undefined
  readonly executor: Executor & DirectExecutorExtensions
  readonly promoter: ExecutionPromoter
  readonly indexRegistry: IndexRegistry
  readonly callbacks: WorkerOrchestratorCallbacks | undefined
  readonly workersEnabled: boolean
  readonly bootstrapModule: string | undefined
  readonly promotionBuffer: WorkerAction[]
  readonly awaitingBufferedWrites: Set<string>
  readonly reportedIneligible: Set<string>
  readonly promotedIndexes: Set<string>
  readonly replicationQueues: Map<string, ReplicationQueue>
  readonly segmentLedger: Map<string, Map<number, SegmentLedgerEntry[]>>
  readonly compactionsInFlight: Map<string, Promise<void>>
  workerPool: WorkerPool | null
  promotionInProgress: boolean
  promotionBlocked: boolean
  promotionRun: Promise<void> | null
}
