import type { PartitionManager } from '../../partitioning/manager'
import type { WAQEntry } from '../../partitioning/write-ahead-queue'
import type { PluginRegistry } from '../../plugins/registry'
import type { EmbeddingAdapter } from '../../types/adapters'
import type { LanguageModule } from '../../types/language'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import type { DirectExecutorExtensions } from '../../workers/direct-executor'
import type { Executor } from '../../workers/executor'
import type { WorkerOrchestrator } from '../orchestration'

export interface DurableWriteToken {
  indexName: string
  partitionId: number
  seqNo: number
}

export type ApplyMutation = () => void | Promise<void>

export interface DurabilityRecorder {
  recordInsertOrUpdate(
    indexName: string,
    docId: string,
    document: AnyDocument,
    apply: ApplyMutation,
  ): Promise<DurableWriteToken>
  recordRemove(indexName: string, docId: string, apply: ApplyMutation): Promise<DurableWriteToken>
}

export interface MutationContext {
  executor: Executor & DirectExecutorExtensions
  pluginRegistry: PluginRegistry
  durability: DurabilityRecorder | null
  orchestrator: WorkerOrchestrator
  idGenerator: () => string
  abortController: AbortController
  guardShutdown: () => void
  requireIndex: (name: string) => {
    config: IndexConfig
    language: LanguageModule
    embeddingAdapter: EmbeddingAdapter | null
    vectorFieldPaths: Set<string>
  }
  requireManager: (name: string) => PartitionManager
  bufferIfRebalancing: (name: string, entry: Omit<WAQEntry, 'sequenceNumber'>) => boolean
}
