import type { EmbeddingAdapter } from '../types/adapters'
import type { PendingAnalysisMetadata } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { IndexConfig } from '../types/schema'

export interface DurableAnalysis {
  generation: number
  language: string
  tokenizer?: string
  stopWords?: string
  stopWordList?: string[]
  analysisRevision: string | null
}

export type IndexRegistryEntry = {
  config: IndexConfig
  language: LanguageModule
  embeddingAdapter: EmbeddingAdapter | null
  /** Registry name the adapter was resolved from; lets durability metadata
   * persist the binding and lets late registration rebind recovered indexes. */
  embeddingAdapterName: string | null
  vectorFieldPaths: Set<string>
  /** The identity the cluster gave this index, or null where no cluster owns it. */
  indexUuid: string | null
  /** The partitions this copy holds, or null where nothing has recorded them yet. */
  heldPartitions: number[] | null
  documentCount: number
  partitionCount: number
  analysisRevision: string | null
  synonyms: Uint8Array | null
  analysisGeneration: number
  pendingAnalysis: PendingAnalysisMetadata | null
  durableAnalysis: DurableAnalysis | null
}
