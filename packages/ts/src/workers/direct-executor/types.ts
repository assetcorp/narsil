import type { PartitionManager } from '../../partitioning/manager'
import type { FulltextSearchOptions } from '../../search/fulltext'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig, VectorStorageMode } from '../../types/schema'
import type { VectorIndex, VectorSearcher, VectorWorkerCopyPolicy } from '../../vector/vector-index'
import type { HeldVectorCopies } from '../vector-copies'

export interface IndexQueryContext {
  manager: PartitionManager
  config: IndexConfig
  language: LanguageModule
  /** This thread holds these vector fields in place for the index, one for each field it has received. */
  vectorSearchers: ReadonlyMap<string, VectorSearcher>
  /** True where the main copy reported its stored analysis stale when it sent this copy. */
  analysisStale: boolean
}

export interface DirectExecutorExtensions {
  getManager(indexName: string): PartitionManager | undefined
  queryContextOf(indexName: string): IndexQueryContext | undefined
  /** Reports whether this thread holds a vector field of the index in place. */
  holdsVectorField(indexName: string, fieldName: string): boolean
  /** Reads a document's vector from a field this thread holds in place, or undefined where it holds none for the document. */
  heldVectorOf(indexName: string, fieldName: string, docId: string): Float32Array | undefined
  createIndex(indexName: string, config: IndexConfig, language: LanguageModule, analysisStale?: boolean): void
  dropIndex(indexName: string): void
  listIndexes(): string[]
}

export interface IndexEntry {
  manager: PartitionManager
  config: IndexConfig
  language: LanguageModule
  searchOptions: FulltextSearchOptions
  vectorIndexes: Map<string, VectorIndex>
  vectorCopies: HeldVectorCopies
  analysisStale: boolean
  awaitedCopyLoad: string | null
}

export interface DetachedIndex {
  readonly indexName: string
  readonly manager: PartitionManager
  readonly entry: IndexEntry
  attach(): void
}

export interface IndexReplacement {
  readonly vectorWorkerCopies: VectorWorkerCopyPolicy
  createDetachedEntry(
    indexName: string,
    config: IndexConfig,
    language: LanguageModule,
    copies: VectorWorkerCopyPolicy,
  ): IndexEntry
  installDetachedIndex(detached: DetachedIndex): void
  discardDetachedIndex(detached: DetachedIndex): void
}

export interface DirectExecutorOptions {
  vectorWorkerCopies?: VectorWorkerCopyPolicy
  /** The thread writes into this scratch slot inside every vector block it opens, and it takes the same slot in every graph's lock record. */
  threadSlot?: number
  /** A vector field whose configuration names no storage keeps its full-precision vectors here. */
  vectorStorage?: VectorStorageMode
}
