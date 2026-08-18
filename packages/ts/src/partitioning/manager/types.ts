import type { ResolvedAnalysis } from '../../analysis/registry'
import type { ComparableSortValue } from '../../core/ordering'
import type { PartitionIndex, PartitionInsertOptions } from '../../core/partition'
import type { FrozenSegment } from '../../core/partition/frozen'
import type { SegmentPayload } from '../../core/partition/segment-payload'
import type { ResolvedProjection } from '../../core/projection'
import type { SerializablePartition } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { PartitionStatsResult } from '../../types/results'
import type { AnyDocument, IndexConfig, SchemaDefinition } from '../../types/schema'
import type { VectorIndex } from '../../vector/vector-index'

export interface PartitionManager {
  readonly partitionCount: number
  readonly indexName: string
  readonly schema: SchemaDefinition
  readonly language: LanguageModule
  readonly config: IndexConfig
  readonly analysis: ResolvedAnalysis

  getPartition(partitionId: number): PartitionIndex
  partitionAt(index: number): PartitionIndex | undefined
  getAllPartitions(): PartitionIndex[]
  setPartitions(partitions: PartitionIndex[]): void
  addPartition(): PartitionIndex
  removePartition(partitionId: number): void
  trimPartitions(count: number): void

  assertCapacity(pendingWrites?: number, partitionCountCap?: number): void
  insert(docId: string, document: AnyDocument, options?: PartitionInsertOptions): void
  remove(docId: string): void
  beginBatchRemove(): void
  endBatchRemove(): void
  update(docId: string, document: AnyDocument, options?: PartitionInsertOptions): void
  rebuildTextIndex(partitionId: number): void
  get(docId: string, projection?: ResolvedProjection): AnyDocument | undefined
  getRef(docId: string): AnyDocument | undefined
  sortValues(
    docId: string,
    fields: readonly string[],
    fieldTypes: readonly (string | undefined)[],
  ): ComparableSortValue[]
  has(docId: string): boolean
  partitionIdOf(docId: string): number | undefined
  countDocuments(): number

  serializePartition(partitionId: number): SerializablePartition
  serializePartitionToBytes(partitionId: number): Uint8Array
  deserializePartition(partitionId: number, data: SerializablePartition): void
  mergeSegment(partitionId: number, payload: SegmentPayload, documents: ReadonlyArray<AnyDocument>): void
  attachFrozenSegment(partitionId: number, segment: FrozenSegment): void
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
