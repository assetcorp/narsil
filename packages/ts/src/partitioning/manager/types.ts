import type { ResolvedAnalysis } from '../../analysis/registry'
import type { ComparableSortValue, SortMode } from '../../core/ordering'
import type { PartitionIndex, PartitionInsertOptions } from '../../core/partition'
import type { LiveTailFreezer } from '../../core/partition/composite/compaction'
import type { FrozenSegment } from '../../core/partition/frozen'
import type { RemovedSpellings, TextAnalysis } from '../../core/partition/frozen/surface-slot'
import type { PartialWordAnalysis } from '../../core/partition/partial-words/spellings'
import type { SegmentPayload } from '../../core/partition/segment-payload'
import type { ResolvedProjection } from '../../core/projection'
import type { SynonymLookup } from '../../core/synonyms/types'
import type { SerializablePartition } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { PartitionStatsResult } from '../../types/results'
import type { AnyDocument, IndexConfig, SchemaDefinition } from '../../types/schema'
import type { VectorIndex } from '../../vector/vector-index'
import type { PartitionWriteLog } from './write-log'

export interface PartitionManager {
  readonly partitionCount: number
  readonly indexName: string
  readonly schema: SchemaDefinition
  readonly language: LanguageModule
  readonly config: IndexConfig
  readonly analysis: ResolvedAnalysis
  readonly partialWordAnalysis: PartialWordAnalysis | null
  readonly synonyms: SynonymLookup | null
  replaceSynonyms(lookup: SynonymLookup | null): void
  readonly textAnalysis: TextAnalysis

  getPartition(partitionId: number): PartitionIndex
  partitionAt(index: number): PartitionIndex | undefined
  getAllPartitions(): PartitionIndex[]
  setPartitions(partitions: PartitionIndex[]): void
  openWriteLog(): PartitionWriteLog
  adoptRebuiltPartitions(rebuilt: PartitionIndex[]): void
  addPartition(): PartitionIndex
  removePartition(partitionId: number): void
  trimPartitions(count: number): void

  assertCapacity(pendingWrites?: number, partitionCountCap?: number): void
  assertPartitionCapacity(partitionId: number, pendingWrites?: number): void
  routePartition(docId: string): number
  insert(docId: string, document: AnyDocument, options?: PartitionInsertOptions): void
  removedSpellingsOf(docId: string): RemovedSpellings | undefined
  remove(docId: string, removedSpellings?: RemovedSpellings): void
  beginBatchRemove(): void
  endBatchRemove(): void
  update(
    docId: string,
    document: AnyDocument,
    options?: PartitionInsertOptions,
    removedSpellings?: RemovedSpellings,
  ): void
  get(docId: string, projection?: ResolvedProjection): AnyDocument | undefined
  getRef(docId: string): AnyDocument | undefined
  fieldValues(docId: string, fieldPaths: readonly string[]): unknown[] | undefined
  sortValues(
    docId: string,
    fields: readonly string[],
    fieldTypes: readonly (string | undefined)[],
    modes: readonly SortMode[],
  ): ComparableSortValue[]
  has(docId: string): boolean
  partitionIdOf(docId: string): number | undefined
  countDocuments(): number

  serializePartition(partitionId: number): SerializablePartition
  deserializePartition(partitionId: number, data: SerializablePartition): void
  mergeSegment(partitionId: number, payload: SegmentPayload, documents: ReadonlyArray<AnyDocument>): void
  attachFrozenSegment(partitionId: number, segment: FrozenSegment): void
  swapFrozenSegments(
    partitionId: number,
    dropSegmentIds: readonly string[],
    replacement: FrozenSegment,
    removedSpellings?: ReadonlyMap<string, RemovedSpellings>,
  ): Map<string, RemovedSpellings>
  freezeLiveTail(partitionId: number, freeze: LiveTailFreezer): FrozenSegment | null
  replaceLiveTail(partitionId: number, segment: FrozenSegment): void
  getAggregateStats(): {
    totalDocuments: number
    docFrequencies: Record<string, number>
    totalFieldLengths: Record<string, number>
  }
  estimateMemoryBytes(): number
  getPartitionStats(): PartitionStatsResult[]
  getVectorIndexes(): Map<string, VectorIndex>
  resetVectorIndexes(newIndexes: Map<string, VectorIndex>): void
}
