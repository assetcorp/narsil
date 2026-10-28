import { resolveIndexAnalysis } from '../../analysis/registry'
import type { ComparableSortValue } from '../../core/ordering'
import { createPartitionIndex, type PartitionIndex, type PartitionInsertOptions } from '../../core/partition'
import { type CompositePartition, createCompositePartition, isCompositePartition } from '../../core/partition/composite'
import type { LiveTailFreezer } from '../../core/partition/composite/compaction'
import type { FrozenSegment } from '../../core/partition/frozen'
import type { RemovedSpellings } from '../../core/partition/frozen/surface-slot'
import { requirePartialWordSearchFor } from '../../core/partition/partial-words/registry'
import type { SegmentPayload } from '../../core/partition/segment-payload'
import { requirePatternSearchFor } from '../../core/pattern-index/registry'
import type { ResolvedProjection } from '../../core/projection'
import type { SynonymLookup } from '../../core/synonyms/types'
import { ErrorCodes, NarsilError } from '../../errors'
import type { SerializablePartition } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import type { VectorIndex } from '../../vector/vector-index'
import { resolvePartialWordAnalysis, resolvePartitionInsertOptions } from '../insert-options'
import type { PartitionRouter } from '../router'
import { createCapacityChecks } from './capacity'
import { mapEveryDocument, mapSegmentDocuments, remapPartitionDocuments } from './doc-locations'
import { copyVectorsInto } from './nested-values'
import { requireNewSegmentDocuments } from './segments'
import { aggregateStatsOf, estimateBytesOf, partitionStatsOf } from './stats'
import type { PartitionManager } from './types'
import { createWriteLogRecorder } from './write-log'

export type { PartitionManager } from './types'

export function createPartitionManager(
  indexName: string,
  config: IndexConfig,
  language: LanguageModule,
  router: PartitionRouter,
  initialPartitionCount?: number,
  vectorIndexes?: Map<string, VectorIndex>,
): PartitionManager {
  requirePatternSearchFor(config.schema)
  requirePartialWordSearchFor(config.schema)
  const count = initialPartitionCount ?? 1
  const analysis = resolveIndexAnalysis(config)
  const partialWordAnalysis = resolvePartialWordAnalysis(config, language, analysis)
  const textAnalysis = { language, options: resolvePartitionInsertOptions(config, analysis) }
  const trackPositions = config.trackPositions ?? true
  const vecIndexes: Map<string, VectorIndex> = vectorIndexes ?? new Map()
  let partitions: PartitionIndex[] = []
  const docPartitionMap = new Map<string, number>()
  const writeLog = createWriteLogRecorder()
  let synonyms: SynonymLookup | null = null

  for (let i = 0; i < count; i++) {
    partitions.push(createPartitionIndex(i, trackPositions))
  }

  function validatePartitionId(partitionId: number): void {
    if (partitionId < 0 || partitionId >= partitions.length) {
      throw new NarsilError(
        ErrorCodes.INDEX_NOT_FOUND,
        `Partition ${partitionId} is out of bounds (0..${partitions.length - 1})`,
        { partitionId, partitionCount: partitions.length },
      )
    }
  }

  function resolveInsertOptions(options?: PartitionInsertOptions): PartitionInsertOptions | undefined {
    return resolvePartitionInsertOptions(config, analysis, options)
  }

  function preparePartialWords(partitionId: number): void {
    if (partialWordAnalysis !== null) partitions[partitionId].preparePartialWords(partialWordAnalysis)
  }

  function locateDocument(docId: string): number | undefined {
    return docPartitionMap.get(docId)
  }

  function asCompositePartition(partitionId: number): CompositePartition {
    const existing = partitions[partitionId]
    if (isCompositePartition(existing)) return existing
    const composite = createCompositePartition(partitionId, trackPositions, existing, textAnalysis)
    partitions[partitionId] = composite
    return composite
  }

  const manager: PartitionManager = {
    get partitionCount() {
      return partitions.length
    },
    get indexName() {
      return indexName
    },
    get schema() {
      return config.schema
    },
    get language() {
      return language
    },
    get config() {
      return config
    },
    get analysis() {
      return analysis
    },
    get partialWordAnalysis() {
      return partialWordAnalysis
    },
    get synonyms() {
      return synonyms
    },
    replaceSynonyms(lookup: SynonymLookup | null): void {
      synonyms = lookup
    },
    get textAnalysis() {
      return textAnalysis
    },

    getPartition(partitionId: number): PartitionIndex {
      validatePartitionId(partitionId)
      return partitions[partitionId]
    },

    partitionAt(index: number): PartitionIndex | undefined {
      return partitions[index]
    },

    getAllPartitions(): PartitionIndex[] {
      return [...partitions]
    },

    setPartitions(newPartitions: PartitionIndex[]): void {
      writeLog.partitionsReplaced()
      partitions = [...newPartitions]
      mapEveryDocument(docPartitionMap, partitions)
    },

    openWriteLog() {
      return writeLog.open()
    },

    adoptRebuiltPartitions(rebuilt: PartitionIndex[]): void {
      if (rebuilt.length !== partitions.length) {
        throw new NarsilError(
          ErrorCodes.PARTITION_CORRUPTED,
          `Index "${indexName}" holds ${partitions.length} partitions, but the rebuild produced ${rebuilt.length}`,
          { indexName, partitionCount: partitions.length, rebuiltCount: rebuilt.length },
        )
      }
      partitions = [...rebuilt]
    },

    addPartition(): PartitionIndex {
      const currentMaxPartitions = config.partitions?.maxPartitions
      if (currentMaxPartitions !== undefined && partitions.length >= currentMaxPartitions) {
        throw new NarsilError(
          ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
          `Cannot add partition: maximum of ${currentMaxPartitions} partitions reached`,
          { maxPartitions: currentMaxPartitions, currentCount: partitions.length },
        )
      }
      const partition = createPartitionIndex(partitions.length, trackPositions)
      writeLog.partitionsReplaced()
      partitions.push(partition)
      return partition
    },

    removePartition(partitionId: number): void {
      validatePartitionId(partitionId)
      writeLog.partitionsReplaced()
      partitions.splice(partitionId, 1)
      mapEveryDocument(docPartitionMap, partitions)
    },

    trimPartitions(newCount: number): void {
      if (newCount < 1) {
        throw new NarsilError(ErrorCodes.CONFIG_INVALID, `Cannot trim index "${indexName}" below one partition`, {
          indexName,
          requestedCount: newCount,
        })
      }
      if (newCount >= partitions.length) {
        return
      }
      writeLog.partitionsReplaced()
      for (const [docId, pid] of docPartitionMap) {
        if (pid >= newCount) {
          docPartitionMap.delete(docId)
        }
      }
      partitions.length = newCount
    },

    ...createCapacityChecks({
      indexName,
      config,
      partitionCount: () => partitions.length,
      documentCount: () => manager.countDocuments(),
      getPartition: partitionId => manager.getPartition(partitionId),
    }),

    routePartition(docId: string): number {
      return router.route(docId, partitions.length)
    },

    insert(docId: string, document: AnyDocument, options?: PartitionInsertOptions): void {
      const pid = router.route(docId, partitions.length)
      const insertOpts = resolveInsertOptions(options)
      partitions[pid].insert(docId, document, config.schema, language, insertOpts)
      docPartitionMap.set(docId, pid)
      writeLog.documentWritten(docId)
    },

    removedSpellingsOf(docId: string): RemovedSpellings | undefined {
      const pid = locateDocument(docId)
      const partition = pid === undefined ? undefined : partitions[pid]
      return partition !== undefined && isCompositePartition(partition)
        ? partition.removedSpellingsOf(docId)
        : undefined
    },

    remove(docId: string, removedSpellings?: RemovedSpellings): void {
      const pid = locateDocument(docId)
      if (pid === undefined) {
        throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found in any partition`, { docId })
      }
      partitions[pid].remove(docId, config.schema, language, resolveInsertOptions(), removedSpellings)
      docPartitionMap.delete(docId)
      writeLog.documentWritten(docId)
    },

    beginBatchRemove(): void {
      for (let i = 0; i < partitions.length; i++) {
        partitions[i].beginBatch()
      }
    },

    endBatchRemove(): void {
      for (let i = 0; i < partitions.length; i++) {
        partitions[i].endBatch()
      }
    },

    update(
      docId: string,
      document: AnyDocument,
      options?: PartitionInsertOptions,
      removedSpellings?: RemovedSpellings,
    ): void {
      const pid = locateDocument(docId)
      if (pid === undefined) {
        throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found in any partition`, { docId })
      }
      const updateOpts = resolveInsertOptions(options)
      partitions[pid].update(docId, document, config.schema, language, updateOpts, removedSpellings)
      docPartitionMap.set(docId, pid)
      writeLog.documentWritten(docId)
    },

    get(docId: string, projection?: ResolvedProjection): AnyDocument | undefined {
      const pid = locateDocument(docId)
      if (pid === undefined) return undefined
      const doc = partitions[pid].get(docId, projection)
      if (doc) copyVectorsInto(doc, docId, vecIndexes, projection)
      return doc
    },

    getRef(docId: string): AnyDocument | undefined {
      const pid = locateDocument(docId)
      if (pid === undefined) return undefined
      return partitions[pid].getRef(docId)
    },

    fieldValues(docId: string, fieldPaths: readonly string[]): unknown[] | undefined {
      const pid = locateDocument(docId)
      return pid === undefined ? undefined : partitions[pid].fieldValues(docId, fieldPaths)
    },

    sortValues(docId, fields, fieldTypes, modes): ComparableSortValue[] {
      const pid = locateDocument(docId)
      if (pid === undefined) return fields.map(() => null)
      return partitions[pid].sortValues(docId, fields, fieldTypes, modes)
    },

    has(docId: string): boolean {
      return locateDocument(docId) !== undefined
    },

    partitionIdOf(docId: string): number | undefined {
      return locateDocument(docId)
    },

    countDocuments(): number {
      let total = 0
      for (let i = 0; i < partitions.length; i++) {
        total += partitions[i].count()
      }
      return total
    },

    serializePartition(partitionId: number): SerializablePartition {
      validatePartitionId(partitionId)
      return partitions[partitionId].serialize(indexName, partitions.length, language.name, config.schema)
    },

    mergeSegment(partitionId: number, payload: SegmentPayload, documents: ReadonlyArray<AnyDocument>): void {
      validatePartitionId(partitionId)
      const partition = partitions[partitionId]
      partition.beginBatch()
      partition.mergeSegmentPayload(payload, documents)
      partition.endBatch()
      for (const docId of payload.docIds) {
        docPartitionMap.set(docId, partitionId)
        writeLog.documentWritten(docId)
      }
    },

    attachFrozenSegment(partitionId: number, segment: FrozenSegment): void {
      validatePartitionId(partitionId)
      requireNewSegmentDocuments(segment, docPartitionMap)
      asCompositePartition(partitionId).attachFrozenSegment(segment)
      mapSegmentDocuments(docPartitionMap, partitionId, segment)
      writeLog.segmentWritten(segment)
    },

    swapFrozenSegments(partitionId, dropSegmentIds, replacement, removedSpellings) {
      validatePartitionId(partitionId)
      const applied = asCompositePartition(partitionId).swapFrozenSegments(
        dropSegmentIds,
        replacement,
        removedSpellings,
      )
      mapSegmentDocuments(docPartitionMap, partitionId, replacement)
      return applied
    },

    freezeLiveTail(partitionId: number, freeze: LiveTailFreezer): FrozenSegment | null {
      validatePartitionId(partitionId)
      return asCompositePartition(partitionId).freezeLiveTail(freeze)
    },

    replaceLiveTail(partitionId: number, segment: FrozenSegment): void {
      validatePartitionId(partitionId)
      asCompositePartition(partitionId).replaceLiveTail(segment)
      mapSegmentDocuments(docPartitionMap, partitionId, segment)
    },

    deserializePartition(partitionId: number, data: SerializablePartition): void {
      validatePartitionId(partitionId)
      writeLog.partitionsReplaced()
      partitions[partitionId].deserialize(data, config.schema)
      preparePartialWords(partitionId)
      remapPartitionDocuments(docPartitionMap, partitionId, partitions[partitionId])
    },

    getAggregateStats() {
      return aggregateStatsOf(partitions)
    },

    estimateMemoryBytes(): number {
      return estimateBytesOf(partitions, vecIndexes)
    },

    getPartitionStats() {
      return partitionStatsOf(partitions)
    },

    getVectorIndexes(): Map<string, VectorIndex> {
      return vecIndexes
    },

    resetVectorIndexes(newIndexes: Map<string, VectorIndex>): void {
      vecIndexes.clear()
      for (const [key, value] of newIndexes) {
        vecIndexes.set(key, value)
      }
    },
  }

  return manager
}
