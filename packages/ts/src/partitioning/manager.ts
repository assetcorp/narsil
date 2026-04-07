import { createPartitionIndex, type PartitionIndex, type PartitionInsertOptions } from '../core/partition'
import { ErrorCodes, NarsilError } from '../errors'
import type { SerializablePartition } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { PartitionStatsResult } from '../types/results'
import type { AnyDocument, IndexConfig, SchemaDefinition } from '../types/schema'
import type { VectorIndex } from '../vector/vector-index'
import type { PartitionRouter } from './router'

export interface PartitionManager {
  readonly partitionCount: number
  readonly indexName: string
  readonly schema: SchemaDefinition
  readonly language: LanguageModule
  readonly config: IndexConfig

  getPartition(partitionId: number): PartitionIndex
  partitionAt(index: number): PartitionIndex | undefined
  getAllPartitions(): PartitionIndex[]
  setPartitions(partitions: PartitionIndex[]): void
  addPartition(): PartitionIndex
  removePartition(partitionId: number): void

  insert(docId: string, document: AnyDocument, options?: PartitionInsertOptions): void
  remove(docId: string): void
  beginBatchRemove(): void
  endBatchRemove(): void
  update(docId: string, document: AnyDocument, options?: PartitionInsertOptions): void
  get(docId: string): AnyDocument | undefined
  getRef(docId: string): AnyDocument | undefined
  has(docId: string): boolean
  countDocuments(): number

  serializePartition(partitionId: number): SerializablePartition
  serializePartitionToBytes(partitionId: number): Uint8Array
  deserializePartition(partitionId: number, data: SerializablePartition): void
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

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  if (!path.includes('.')) {
    obj[path] = value
    return
  }
  const segments = path.split('.')
  let current: Record<string, unknown> = obj
  for (let i = 0; i < segments.length - 1; i++) {
    let next = current[segments[i]]
    if (next === null || next === undefined || typeof next !== 'object') {
      next = {}
      current[segments[i]] = next
    }
    current = next as Record<string, unknown>
  }
  current[segments[segments.length - 1]] = value
}

export function createPartitionManager(
  indexName: string,
  config: IndexConfig,
  language: LanguageModule,
  router: PartitionRouter,
  initialPartitionCount?: number,
  vectorIndexes?: Map<string, VectorIndex>,
): PartitionManager {
  const count = initialPartitionCount ?? 1
  const trackPositions = config.trackPositions ?? true
  const vecIndexes: Map<string, VectorIndex> = vectorIndexes ?? new Map()
  let partitions: PartitionIndex[] = []
  const docPartitionMap = new Map<string, number>()

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

  function rebuildDocPartitionMap(): void {
    docPartitionMap.clear()
    for (let i = 0; i < partitions.length; i++) {
      for (const docId of partitions[i].docIds()) {
        docPartitionMap.set(docId, i)
      }
    }
  }

  function rebuildDocPartitionMapForPartition(partitionId: number): void {
    for (const [docId, pid] of docPartitionMap) {
      if (pid === partitionId) {
        docPartitionMap.delete(docId)
      }
    }
    for (const docId of partitions[partitionId].docIds()) {
      docPartitionMap.set(docId, partitionId)
    }
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
      partitions = [...newPartitions]
      rebuildDocPartitionMap()
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
      partitions.push(partition)
      return partition
    },

    removePartition(partitionId: number): void {
      validatePartitionId(partitionId)
      partitions.splice(partitionId, 1)
      rebuildDocPartitionMap()
    },

    insert(docId: string, document: AnyDocument, options?: PartitionInsertOptions): void {
      const currentMaxDocs = config.partitions?.maxDocsPerPartition
      if (currentMaxDocs !== undefined) {
        const totalCapacity = currentMaxDocs * partitions.length
        if (docPartitionMap.size >= totalCapacity) {
          throw new NarsilError(
            ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
            `Index "${indexName}" has reached its capacity of ${totalCapacity} documents (${currentMaxDocs} per partition × ${partitions.length} partitions)`,
            {
              indexName,
              currentCount: docPartitionMap.size,
              totalCapacity,
              maxDocsPerPartition: currentMaxDocs,
              partitionCount: partitions.length,
            },
          )
        }
      }
      const pid = router.route(docId, partitions.length)
      const insertOpts = config.strict ? { ...options, strict: true } : options
      partitions[pid].insert(docId, document, config.schema, language, insertOpts)
      docPartitionMap.set(docId, pid)
    },

    remove(docId: string): void {
      const pid = docPartitionMap.get(docId)
      if (pid === undefined) {
        throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found in any partition`, { docId })
      }
      partitions[pid].remove(docId, config.schema, language)
      docPartitionMap.delete(docId)
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

    update(docId: string, document: AnyDocument, options?: PartitionInsertOptions): void {
      const pid = docPartitionMap.get(docId)
      if (pid === undefined) {
        throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found in any partition`, { docId })
      }
      const updateOpts = config.strict ? { ...options, strict: true } : options
      partitions[pid].update(docId, document, config.schema, language, updateOpts)
    },

    get(docId: string): AnyDocument | undefined {
      const pid = docPartitionMap.get(docId)
      if (pid === undefined) return undefined
      const doc = partitions[pid].get(docId)
      if (!doc) return undefined
      for (const [fieldPath, vecIndex] of vecIndexes) {
        const vector = vecIndex.getVector(docId)
        if (vector) {
          setNestedValue(doc as Record<string, unknown>, fieldPath, vector)
        }
      }
      return doc
    },

    getRef(docId: string): AnyDocument | undefined {
      const pid = docPartitionMap.get(docId)
      if (pid === undefined) return undefined
      return partitions[pid].getRef(docId)
    },

    has(docId: string): boolean {
      return docPartitionMap.has(docId)
    },

    countDocuments(): number {
      return docPartitionMap.size
    },

    serializePartition(partitionId: number): SerializablePartition {
      validatePartitionId(partitionId)
      return partitions[partitionId].serialize(indexName, partitions.length, language.name, config.schema)
    },

    serializePartitionToBytes(partitionId: number): Uint8Array {
      validatePartitionId(partitionId)
      return partitions[partitionId].serializeToBytes(indexName, partitions.length, language.name, config.schema)
    },

    deserializePartition(partitionId: number, data: SerializablePartition): void {
      validatePartitionId(partitionId)
      partitions[partitionId].deserialize(data, config.schema)
      rebuildDocPartitionMapForPartition(partitionId)
    },

    getAggregateStats(): {
      totalDocuments: number
      docFrequencies: Record<string, number>
      totalFieldLengths: Record<string, number>
    } {
      let totalDocuments = 0
      const docFrequencies: Record<string, number> = {}
      const totalFieldLengths: Record<string, number> = {}

      for (let i = 0; i < partitions.length; i++) {
        const stats = partitions[i].stats
        totalDocuments += stats.totalDocuments

        for (const [term, freq] of Object.entries(stats.docFrequencies)) {
          docFrequencies[term] = (docFrequencies[term] ?? 0) + freq
        }

        for (const [field, length] of Object.entries(stats.totalFieldLengths)) {
          totalFieldLengths[field] = (totalFieldLengths[field] ?? 0) + length
        }
      }

      return { totalDocuments, docFrequencies, totalFieldLengths }
    },

    estimateMemoryBytes(): number {
      let total = 0
      for (let i = 0; i < partitions.length; i++) {
        total += partitions[i].estimateMemoryBytes()
      }
      for (const [, vecIndex] of vecIndexes) {
        total += vecIndex.estimateMemoryBytes()
      }
      return total
    },

    getPartitionStats(): PartitionStatsResult[] {
      return partitions.map((p, i) => ({
        partitionId: i,
        documentCount: p.count(),
        estimatedMemoryBytes: p.estimateMemoryBytes(),
      }))
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
