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
  flush?: FlushConfig
  eagerLoad?: boolean
  embedding?: EmbeddingAdapter
}

export interface WorkerConfig {
  enabled?: boolean
  count?: number
  promotionThreshold?: number
  totalPromotionThreshold?: number
}

export interface FlushConfig {
  interval?: number
  mutationThreshold?: number
}
