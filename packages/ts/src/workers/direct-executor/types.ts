import type { SynonymLookup } from '../../core/synonyms/types'
import type { PartitionManager } from '../../partitioning/manager'
import type { FulltextSearchOptions } from '../../search/fulltext'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig, VectorStorageMode } from '../../types/schema'
import type { VectorIndex, VectorSearcher, VectorWorkerCopyPolicy } from '../../vector/vector-index'
import type { runQueryAction } from '../query-actions'
import type { HeldFieldPin, HeldVectorCopies } from '../vector-copies'
import type { CopyPublicationOrder, initializeCopyPublication, publishCopyAction } from './publication'

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
  /**
   * Reads a document's vector at this copy's published cutoff, or returns undefined when the document has no vector.
   */
  heldVectorOf(indexName: string, fieldName: string, docId: string): Float32Array | undefined
  /**
   * Pins the current state of a vector field that this thread holds in place, or returns undefined where it holds
   * none. A search reads the field at that pin until the caller releases it, and the main thread frees no vector that
   * the pin admits until then.
   */
  pinVectorField(indexName: string, fieldName: string): HeldFieldPin | undefined
  createIndex(
    indexName: string,
    config: IndexConfig,
    language: LanguageModule,
    analysisStale?: boolean,
    synonyms?: SynonymLookup | null,
  ): void
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
  copyPublications: CopyPublicationOrder
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
  publishCopyAction?: typeof publishCopyAction
  initializeCopyPublication?: typeof initializeCopyPublication
  vectorWorkerCopies?: VectorWorkerCopyPolicy
  /** The thread writes into this scratch slot inside every vector block it opens, and it takes the same slot in every graph's lock record. */
  threadSlot?: number
  /** A vector field whose configuration names no storage keeps its full-precision vectors here. */
  vectorStorage?: VectorStorageMode
  onVectorGraphRepaired?: (indexName: string) => void
  /** A worker thread answers query and preflight actions with this function, which the thread that owns the main copy never receives. */
  runQueryAction?: typeof runQueryAction
}
