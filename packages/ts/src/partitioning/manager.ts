import { createPartitionIndex, type PartitionIndex, type PartitionInsertOptions } from '../core/partition'
import { ErrorCodes, NarsilError } from '../errors'
import type { SerializablePartition } from '../types/internal'
import type { LanguageModule } from '../types/language'
import type { AnyDocument, IndexConfig, SchemaDefinition } from '../types/schema'
import type { PartitionRouter } from './router'

export interface PartitionManager {
  readonly partitionCount: number
  readonly indexName: string
  readonly schema: SchemaDefinition
  readonly language: LanguageModule
  readonly config: IndexConfig

  getPartition(partitionId: number): PartitionIndex
  getAllPartitions(): PartitionIndex[]
  setPartitions(partitions: PartitionIndex[]): void
  addPartition(): PartitionIndex
  removePartition(partitionId: number): void

  insert(docId: string, document: AnyDocument, options?: PartitionInsertOptions): void
  remove(docId: string): void
  update(docId: string, document: AnyDocument, options?: PartitionInsertOptions): void
  get(docId: string): AnyDocument | undefined
  getRef(docId: string): AnyDocument | undefined
  has(docId: string): boolean
  countDocuments(): number

  serializePartition(partitionId: number): SerializablePartition
  deserializePartition(partitionId: number, data: SerializablePartition): void
  getAggregateStats(): {
    totalDocuments: number
    docFrequencies: Record<string, number>
    totalFieldLengths: Record<string, number>
  }
}

export function createPartitionManager(
  indexName: string,
  config: IndexConfig,
  language: LanguageModule,
  router: PartitionRouter,
  initialPartitionCount?: number,
): PartitionManager {
  const count = initialPartitionCount ?? 1
  let partitions: PartitionIndex[] = []
  const docPartitionMap = new Map<string, number>()

  for (let i = 0; i < count; i++) {
    partitions.push(createPartitionIndex(i))
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

    getAllPartitions(): PartitionIndex[] {
      return [...partitions]
    },

    setPartitions(newPartitions: PartitionIndex[]): void {
      partitions = [...newPartitions]
      rebuildDocPartitionMap()
    },

    addPartition(): PartitionIndex {
      const partition = createPartitionIndex(partitions.length)
      partitions.push(partition)
      return partition
    },

    removePartition(partitionId: number): void {
      validatePartitionId(partitionId)
      partitions.splice(partitionId, 1)
      rebuildDocPartitionMap()
    },

    insert(docId: string, document: AnyDocument, options?: PartitionInsertOptions): void {
      const pid = router.route(docId, partitions.length)
      partitions[pid].insert(docId, document, config.schema, language, options)
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

    update(docId: string, document: AnyDocument, options?: PartitionInsertOptions): void {
      const pid = docPartitionMap.get(docId)
      if (pid === undefined) {
        throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found in any partition`, { docId })
      }
      partitions[pid].update(docId, document, config.schema, language, options)
    },

    get(docId: string): AnyDocument | undefined {
      const pid = docPartitionMap.get(docId)
      if (pid === undefined) return undefined
      return partitions[pid].get(docId)
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
  }

  return manager
}
