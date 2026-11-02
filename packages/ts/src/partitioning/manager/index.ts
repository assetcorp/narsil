import { resolveIndexAnalysis } from '../../analysis/registry'
import type { ComparableSortValue } from '../../core/ordering'
import { createPartitionIndex, type PartitionIndex, type PartitionInsertOptions } from '../../core/partition'
import { type CompositePartition, createCompositePartition, isCompositePartition } from '../../core/partition/composite'
import type { RemovedSpellings } from '../../core/partition/frozen/surface-slot'
import { requirePartialWordSearchFor } from '../../core/partition/partial-words/registry'
import { requirePatternSearchFor } from '../../core/pattern-index/registry'
import type { ResolvedProjection } from '../../core/projection'
import { ErrorCodes, NarsilError } from '../../errors'
import type { SerializablePartition } from '../../types/internal'
import type { LanguageModule } from '../../types/language'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import type { VectorIndex } from '../../vector/vector-index'
import { resolvePartialWordAnalysis, resolvePartitionInsertOptions } from '../insert-options'
import type { PartitionRouter } from '../router'
import { createCapacityChecks } from './capacity'
import { rebuildDocLocations, rebuildPartitionDocLocations } from './doc-locations'
import { copyVectorsInto } from './nested-values'
import { createSegmentOperations } from './segment-operations'
import { aggregateStatsOf, estimateBytesOf, partitionStatsOf } from './stats'
import type { PartitionManager } from './types'
import { createWriteLogRecorder, REANALYSIS_WRITE_LOG } from './write-log'

export type { PartitionManager } from './types'

function closePagedSegmentsLeftBehind(earlier: readonly PartitionIndex[], kept: readonly PartitionIndex[]): void {
  for (const partition of earlier) {
    if (!isCompositePartition(partition) || kept.includes(partition)) continue
    for (const segment of partition.frozenSegments()) segment.paged?.close()
  }
}

export function createPartitionManager(
  indexName: string,
  initialConfig: IndexConfig,
  initialLanguage: LanguageModule,
  router: PartitionRouter,
  initialPartitionCount?: number,
  vectorIndexes?: Map<string, VectorIndex>,
): PartitionManager {
  let config = initialConfig
  let language = initialLanguage
  requirePatternSearchFor(config.schema)
  requirePartialWordSearchFor(config.schema)
  const count = initialPartitionCount ?? 1
  let analysis = resolveIndexAnalysis(config)
  let partialWordAnalysis = resolvePartialWordAnalysis(config, language, analysis)
  let textAnalysis = { language, options: resolvePartitionInsertOptions(config, analysis) }
  const trackPositions = config.trackPositions ?? true
  const vecIndexes: Map<string, VectorIndex> = vectorIndexes ?? new Map()
  let partitions: PartitionIndex[] = []
  const docPartitionMap = new Map<string, number>()
  const writeLogs = createWriteLogRecorder()

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
    const known = docPartitionMap.get(docId)
    if (known !== undefined || config.textStorage !== 'disk') return known
    const routed = router.route(docId, partitions.length)
    if (partitions[routed]?.has(docId)) return routed
    for (let i = 0; i < partitions.length; i++) {
      if (i !== routed && partitions[i].has(docId)) return i
    }
    return undefined
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
    synonyms: null,
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
      writeLogs.partitionsReplaced()
      const earlier = partitions
      partitions = [...newPartitions]
      closePagedSegmentsLeftBehind(earlier, partitions)
      rebuildDocLocations(docPartitionMap, partitions)
    },

    openWriteLog() {
      return writeLogs.open(REANALYSIS_WRITE_LOG)
    },

    adoptRebuiltPartitions(rebuilt: PartitionIndex[]): void {
      if (rebuilt.length !== partitions.length) {
        throw new NarsilError(
          ErrorCodes.PARTITION_CORRUPTED,
          `Index "${indexName}" holds ${partitions.length} partitions, but the rebuild produced ${rebuilt.length}`,
          { indexName, partitionCount: partitions.length, rebuiltCount: rebuilt.length },
        )
      }
      const earlier = partitions
      partitions = [...rebuilt]
      closePagedSegmentsLeftBehind(earlier, partitions)
    },

    adoptAnalysis(change): void {
      config = change.config
      language = change.language
      analysis = change.analysis
      partialWordAnalysis = change.partialWordAnalysis
      textAnalysis = { language, options: resolvePartitionInsertOptions(config, analysis) }
      manager.synonyms = change.synonyms
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
      writeLogs.partitionsReplaced()
      partitions.push(partition)
      return partition
    },

    removePartition(partitionId: number): void {
      validatePartitionId(partitionId)
      writeLogs.partitionsReplaced()
      partitions.splice(partitionId, 1)
      rebuildDocLocations(docPartitionMap, partitions)
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
      writeLogs.partitionsReplaced()
      for (const [docId, pid] of docPartitionMap) {
        if (pid >= newCount) {
          docPartitionMap.delete(docId)
        }
      }
      partitions.length = newCount
    },

    ...createCapacityChecks({
      indexName,
      config: initialConfig,
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
      writeLogs.documentWritten(docId)
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
      writeLogs.documentWritten(docId)
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
      writeLogs.documentWritten(docId)
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

    ...createSegmentOperations({
      docPartitionMap,
      writeLogs,
      partitionAt: partitionId => partitions[partitionId],
      validatePartitionId,
      asCompositePartition,
      resolveInsertOptions: () => resolveInsertOptions(),
    }),

    deserializePartition(partitionId: number, data: SerializablePartition): void {
      validatePartitionId(partitionId)
      writeLogs.partitionsReplaced()
      partitions[partitionId].deserialize(data, config.schema)
      preparePartialWords(partitionId)
      rebuildPartitionDocLocations(docPartitionMap, partitionId, partitions[partitionId])
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
