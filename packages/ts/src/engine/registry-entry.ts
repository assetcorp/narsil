import type { EmbeddingAdapter } from '../types/adapters'
import type { PendingAnalysisMetadata } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { IndexConfig } from '../types/schema'

export interface DurableAnalysis extends PendingAnalysisMetadata {
  analysisRevision: string | null
  arrayPositionGap: number | null
}

export type IndexRegistryEntry = {
  config: IndexConfig
  language: LanguageModule
  embeddingAdapter: EmbeddingAdapter | null
  embeddingAdapterName: string | null
  vectorFieldPaths: Set<string>
  indexUuid: string | null
  heldPartitions: number[] | null
  documentCount: number
  partitionCount: number
  analysisRevision: string | null
  arrayPositionGap: number | null
  synonyms: Uint8Array | null
  analysisGeneration: number
  pendingAnalysis: PendingAnalysisMetadata | null
  durableAnalysis: DurableAnalysis | null
}
