import type { EmbeddingAdapter, InvalidationAdapter, PersistenceAdapter } from './adapters'
import type { NarsilPlugin } from './plugins'
import type { BM25Params, CustomTokenizer } from './schema'

export type { BM25Params, CustomTokenizer }

export interface NarsilConfig {
  persistence?: PersistenceAdapter
  invalidation?: InvalidationAdapter
  plugins?: NarsilPlugin[]
  idGenerator?: () => string
  workers?: WorkerConfig
  embedding?: EmbeddingAdapter
  /** Named adapters; names persist in index metadata so recovery can rebind. */
  embeddingAdapters?: Record<string, EmbeddingAdapter>
  durability?: DurabilityConfig
  analysis?: AnalysisConfig
}

export interface StaleAnalysis {
  indexName: string
  language: string
  storedRevision: string | null
  currentRevision: string
  documentCount: number
}

export interface AnalysisConfig {
  rebuild?: 'auto' | 'manual'
  onStaleAnalysis?(index: StaleAnalysis, rebuild: () => Promise<void>): void | Promise<void>
}

export interface DurabilityConfig {
  tier?: 'wal' | 'snapshot'
  directory?: string
  mode?: 'sync' | 'async'
  flushIntervalMs?: number
  segmentMaxBytes?: number
  checkpointIntervalMs?: number
  checkpointMutationThreshold?: number
  compactionThreshold?: number
}

export interface WorkerConfig {
  enabled?: boolean
  count?: number
  promotionThreshold?: number
  totalPromotionThreshold?: number
  bootstrapModule?: string
}
