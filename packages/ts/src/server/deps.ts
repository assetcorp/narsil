import type { Narsil } from '../narsil'
import type { EmbeddingAdapter } from '../types/adapters'
import type { TaskRegistry } from './tasks'

export interface ResolvedLimits {
  maxBodyBytes: number
  maxImportBytes: number
  maxLineBytes: number
  importBatchSize: number
  maxConcurrentRequests: number
}

export interface HandlerDeps {
  engine: Narsil
  tasks: TaskRegistry
  adapters: Record<string, EmbeddingAdapter>
  limits: ResolvedLimits
  isReady: () => boolean
}
