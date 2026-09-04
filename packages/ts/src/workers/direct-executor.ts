import { readHeapStatistics } from '#platform/heap-statistics'
import { createPartitionIndex } from '../core/partition'
import { isCompositePartition } from '../core/partition/composite'
import { buildCompactedSegmentPayload } from '../core/partition/composite/compaction'
import { createSharedFrozenSegment, freezeSegmentShared } from '../core/partition/frozen'
import { ErrorCodes, NarsilError } from '../errors'
import { getLanguage } from '../languages/registry'
import { sanitizeGlobalStats } from '../partitioning/distributed-scoring'
import { fanOutQuery } from '../partitioning/fan-out'
import { resolvePartitionInsertOptions } from '../partitioning/insert-options'
import { createPartitionManager, type PartitionManager } from '../partitioning/manager'
import { countsWithoutScores, fanOutMatchCount } from '../partitioning/match-count'
import { createPartitionRouter } from '../partitioning/router'
import { extractVectorFieldsFromSchema } from '../schema/validator'
import type { FulltextSearchOptions } from '../search/fulltext'
import type { LanguageModule } from '../types/language'
import type { IndexConfig } from '../types/schema'
import { createVectorIndex, type VectorIndex, type VectorWorkerCopyPolicy } from '../vector/vector-index'
import type { Executor } from './executor'
import type { WorkerAction } from './protocol'

export interface DirectExecutorExtensions {
  getManager(indexName: string): PartitionManager | undefined
  createIndex(indexName: string, config: IndexConfig, language: LanguageModule): void
  dropIndex(indexName: string): void
  listIndexes(): string[]
}

export interface DirectExecutorOptions {
  vectorWorkerCopies?: VectorWorkerCopyPolicy
}

interface IndexEntry {
  manager: PartitionManager
  config: IndexConfig
  language: LanguageModule
  searchOptions: FulltextSearchOptions
  vectorIndexes: Map<string, VectorIndex>
}

const NO_VECTOR_WORKER_COPIES: VectorWorkerCopyPolicy = { enabled: false }

function growPartitionsTo(manager: PartitionManager, partitionId: number): void {
  while (manager.partitionCount <= partitionId) {
    manager.addPartition()
  }
}

export function createDirectExecutor(options?: DirectExecutorOptions): Executor & DirectExecutorExtensions {
  const indexes = new Map<string, IndexEntry>()
  const vectorWorkerCopies = options?.vectorWorkerCopies ?? NO_VECTOR_WORKER_COPIES

  function requireIndex(indexName: string): IndexEntry {
    const entry = indexes.get(indexName)
    if (!entry) {
      throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" does not exist`, {
        indexName,
      })
    }
    return entry
  }

  function createIndex(indexName: string, config: IndexConfig, language: LanguageModule): void {
    if (indexes.has(indexName)) {
      throw new NarsilError(ErrorCodes.INDEX_ALREADY_EXISTS, `Index "${indexName}" already exists`, {
        indexName,
      })
    }

    const router = createPartitionRouter()
    const partitionCount = config.partitions?.maxPartitions ?? 1

    const vectorFields = extractVectorFieldsFromSchema(config.schema)
    const vectorIndexes = new Map<string, VectorIndex>()
    for (const [fieldPath, dim] of vectorFields) {
      vectorIndexes.set(fieldPath, createVectorIndex(fieldPath, dim, config.vectorPromotion, vectorWorkerCopies))
    }

    const manager = createPartitionManager(indexName, config, language, router, partitionCount, vectorIndexes)

    indexes.set(indexName, {
      manager,
      config,
      language,
      searchOptions: {
        bm25Params: config.bm25,
        stopWords: manager.analysis.stopWords,
        customTokenizer: manager.analysis.customTokenizer,
      },
      vectorIndexes,
    })
  }

  function dropIndex(indexName: string): void {
    const entry = requireIndex(indexName)
    for (const vectorIndex of entry.vectorIndexes.values()) {
      vectorIndex.dispose()
    }
    for (const partition of entry.manager.getAllPartitions()) {
      partition.clear()
    }
    indexes.delete(indexName)
  }

  function listIndexes(): string[] {
    return Array.from(indexes.keys())
  }

  function getManager(indexName: string): PartitionManager | undefined {
    return indexes.get(indexName)?.manager
  }

  async function execute<T>(action: WorkerAction): Promise<T> {
    switch (action.type) {
      case 'bootstrap': {
        throw new NarsilError(
          ErrorCodes.CONFIG_INVALID,
          'A bootstrap module loads inside a worker, and the thread that owns this executor imports it directly',
          { moduleUrl: action.moduleUrl },
        )
      }

      case 'createIndex': {
        const language = getLanguage(action.config.language ?? 'english')
        createIndex(action.indexName, action.config, language)
        return undefined as T
      }

      case 'dropIndex': {
        dropIndex(action.indexName)
        return undefined as T
      }

      case 'insert': {
        const entry = requireIndex(action.indexName)
        entry.manager.insert(action.docId, action.document, action.skipClone ? { skipClone: true } : undefined)
        return undefined as T
      }

      case 'buildSegment': {
        const entry = requireIndex(action.indexName)
        const segment = createPartitionIndex(0, entry.config.trackPositions ?? true)
        const options = resolvePartitionInsertOptions(entry.config, entry.manager.analysis, action.options)
        segment.beginBatch()
        for (const doc of action.documents) {
          segment.insert(doc.docId, doc.document, entry.config.schema, entry.language, options)
        }
        segment.endBatch()
        return segment.encodeSegment() as T
      }

      case 'mergeSegments': {
        const entry = requireIndex(action.indexName)
        for (const segment of action.segments) {
          if (segment.payload.docIds.some(docId => entry.manager.has(docId))) {
            console.warn(
              `Skipping replicated segment for index "${action.indexName}": its documents already exist on this copy`,
            )
            continue
          }
          entry.manager.mergeSegment(segment.partitionId, segment.payload, segment.documents)
        }
        return undefined as T
      }

      case 'attachSegments': {
        const entry = requireIndex(action.indexName)
        for (const segment of action.segments) {
          growPartitionsTo(entry.manager, segment.partitionId)
          const frozen = createSharedFrozenSegment(segment.snapshot)
          for (const docId of segment.tombstonedDocIds ?? []) frozen.tombstoneDocument(docId)
          entry.manager.attachFrozenSegment(segment.partitionId, frozen)
        }
        return undefined as T
      }

      case 'compactSegments': {
        const entry = requireIndex(action.indexName)
        const partition = entry.manager.getPartition(action.partitionId)
        if (!isCompositePartition(partition)) {
          throw new NarsilError(
            ErrorCodes.PARTITION_CORRUPTED,
            `Partition ${action.partitionId} of "${action.indexName}" holds no frozen segments to compact`,
            { indexName: action.indexName, partitionId: action.partitionId },
          )
        }
        const segments = partition.frozenSegmentsById(action.segmentIds)
        const { payload, documents } = buildCompactedSegmentPayload(segments)
        return freezeSegmentShared(payload, documents) as T
      }

      case 'swapSegments': {
        const entry = requireIndex(action.indexName)
        const partition = entry.manager.getPartition(action.partitionId)
        if (!isCompositePartition(partition)) {
          throw new NarsilError(
            ErrorCodes.PARTITION_CORRUPTED,
            `Partition ${action.partitionId} of "${action.indexName}" holds no frozen segments to swap`,
            { indexName: action.indexName, partitionId: action.partitionId },
          )
        }
        partition.swapFrozenSegments(action.dropSegmentIds, createSharedFrozenSegment(action.snapshot))
        return undefined as T
      }

      case 'freezeLiveTail': {
        const entry = requireIndex(action.indexName)
        growPartitionsTo(entry.manager, action.partitionId)
        const tail = entry.manager.getPartition(action.partitionId)
        const held = isCompositePartition(tail) ? tail.live.count() : tail.count()
        if (held !== action.snapshot.documentCount) {
          console.warn(
            `Partition ${action.partitionId} of "${action.indexName}" held ${held} live documents where the frozen tail holds ${action.snapshot.documentCount}`,
          )
        }
        entry.manager.replaceLiveTail(action.partitionId, createSharedFrozenSegment(action.snapshot))
        return undefined as T
      }

      case 'remove': {
        const entry = requireIndex(action.indexName)
        entry.manager.remove(action.docId)
        return undefined as T
      }

      case 'update': {
        const entry = requireIndex(action.indexName)
        entry.manager.update(action.docId, action.document)
        return undefined as T
      }

      case 'query': {
        const entry = requireIndex(action.indexName)
        const result = await fanOutQuery(
          entry.manager,
          action.params,
          entry.language,
          entry.config.schema,
          {
            scoringMode: action.params.scoring ?? entry.config.defaultScoring ?? 'local',
            partitionIds: action.partitionIds,
            ...(action.globalStats !== undefined ? { globalStats: sanitizeGlobalStats(action.globalStats) } : {}),
          },
          entry.searchOptions,
        )
        return result as T
      }

      case 'preflight': {
        const entry = requireIndex(action.indexName)
        if (countsWithoutScores(action.params)) {
          const count = fanOutMatchCount(entry.manager, action.params, entry.language, entry.config.schema, {
            searchOptions: entry.searchOptions,
          })
          return { count } as T
        }
        const result = await fanOutQuery(
          entry.manager,
          action.params,
          entry.language,
          entry.config.schema,
          { scoringMode: entry.config.defaultScoring ?? 'local' },
          entry.searchOptions,
        )
        return { count: result.totalMatched } as T
      }

      case 'get': {
        const entry = requireIndex(action.indexName)
        return entry.manager.get(action.docId) as T
      }

      case 'has': {
        const entry = requireIndex(action.indexName)
        return entry.manager.has(action.docId) as T
      }

      case 'count': {
        const entry = requireIndex(action.indexName)
        return entry.manager.countDocuments() as T
      }

      case 'getStats': {
        const entry = requireIndex(action.indexName)
        return {
          documentCount: entry.manager.countDocuments(),
          partitionCount: entry.manager.partitionCount,
          language: entry.language.name,
          schema: entry.config.schema,
        } as T
      }

      case 'clear': {
        const entry = requireIndex(action.indexName)
        const partitions = entry.manager.getAllPartitions()
        for (const partition of partitions) {
          partition.clear()
        }
        entry.manager.setPartitions(partitions)

        const vectorFields = extractVectorFieldsFromSchema(entry.config.schema)
        const newVectorIndexes = new Map<string, VectorIndex>()
        for (const [fieldPath, dim] of vectorFields) {
          newVectorIndexes.set(
            fieldPath,
            createVectorIndex(fieldPath, dim, entry.config.vectorPromotion, vectorWorkerCopies),
          )
        }
        entry.manager.resetVectorIndexes(newVectorIndexes)
        entry.vectorIndexes = entry.manager.getVectorIndexes()

        return undefined as T
      }

      case 'serialize': {
        const entry = requireIndex(action.indexName)
        return entry.manager.serializePartition(action.partitionId) as T
      }

      case 'deserialize': {
        const entry = requireIndex(action.indexName)
        growPartitionsTo(entry.manager, action.partitionId)
        entry.manager.deserializePartition(action.partitionId, action.data)
        return undefined as T
      }

      case 'memoryReport': {
        const usage = typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage() : {}
        return { ...usage, heapLimit: readHeapStatistics()?.limitBytes ?? null } as T
      }

      case 'shutdown': {
        for (const [, entry] of indexes) {
          for (const partition of entry.manager.getAllPartitions()) {
            partition.clear()
          }
        }
        indexes.clear()
        return undefined as T
      }
    }
  }

  async function shutdown(): Promise<void> {
    await execute({ type: 'shutdown', requestId: 'internal-shutdown' })
  }

  return {
    execute,
    shutdown,
    getManager,
    createIndex,
    dropIndex,
    listIndexes,
  }
}
