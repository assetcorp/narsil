import { readHeapStatistics } from '#platform/heap-statistics'
import { synonymModule } from '../core/synonyms/registry'
import type { SynonymLookup } from '../core/synonyms/types'
import { ErrorCodes, NarsilError } from '../errors'
import { getLanguage } from '../languages/registry'
import { createPartitionManager, type PartitionManager } from '../partitioning/manager'
import { createPartitionRouter } from '../partitioning/router'
import { extractVectorFieldsFromSchema } from '../schema/validator'
import type { FulltextSearchOptions } from '../search/fulltext'
import type { LanguageModule } from '../types/language'
import type { IndexConfig, VectorStorageMode } from '../types/schema'
import {
  createVectorIndex,
  type VectorIndex,
  type VectorSearcher,
  type VectorWorkerCopyPolicy,
} from '../vector/vector-index'
import type { Executor } from './executor'
import type { WorkerAction } from './protocol'
import { runQueryAction } from './query-actions'
import { growPartitionsTo, isSegmentAction, runSegmentAction } from './segment-actions'
import {
  closeHeldVectorCopies,
  createHeldVectorCopies,
  dropHeldVectorCopy,
  type HeldVectorCopies,
  heldVectorOf,
  holdsVectorField,
  insertIntoHeldGraph,
  loadHeldVectorCopy,
} from './vector-copies'

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

export interface DirectExecutorOptions {
  vectorWorkerCopies?: VectorWorkerCopyPolicy
  /** The thread writes into this scratch slot inside every vector block it opens, and it takes the same slot in every graph's lock record. */
  threadSlot?: number
  /** A vector field whose configuration names no storage keeps its full-precision vectors here. */
  vectorStorage?: VectorStorageMode
}

interface IndexEntry {
  manager: PartitionManager
  config: IndexConfig
  language: LanguageModule
  searchOptions: FulltextSearchOptions
  vectorIndexes: Map<string, VectorIndex>
  vectorCopies: HeldVectorCopies
  analysisStale: boolean
  awaitedCopyLoad: string | null
}

const NO_VECTOR_WORKER_COPIES: VectorWorkerCopyPolicy = { enabled: false }

export function createDirectExecutor(options?: DirectExecutorOptions): Executor & DirectExecutorExtensions {
  const indexes = new Map<string, IndexEntry>()
  const vectorWorkerCopies = options?.vectorWorkerCopies ?? NO_VECTOR_WORKER_COPIES
  const threadSlot = options?.threadSlot ?? 0
  const vectorStorage: VectorStorageMode = options?.vectorStorage ?? 'memory'

  function requireIndex(indexName: string): IndexEntry {
    const entry = indexes.get(indexName)
    if (!entry) {
      throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" does not exist`, {
        indexName,
      })
    }
    return entry
  }

  function vectorIndexesFor(indexName: string, config: IndexConfig): Map<string, VectorIndex> {
    const vectorIndexes = new Map<string, VectorIndex>()
    for (const [fieldPath, dim] of extractVectorFieldsFromSchema(config.schema)) {
      vectorIndexes.set(
        fieldPath,
        createVectorIndex(
          fieldPath,
          dim,
          config.vectorPromotion,
          vectorWorkerCopies,
          indexName,
          config.vectorPromotion?.storage ?? vectorStorage,
        ),
      )
    }
    return vectorIndexes
  }

  function createIndex(
    indexName: string,
    config: IndexConfig,
    language: LanguageModule,
    analysisStale = false,
    synonyms: SynonymLookup | null = null,
  ): void {
    addIndex(indexName, config, language, analysisStale, null).replaceSynonyms(synonyms)
  }

  function lookupOf(
    config: IndexConfig,
    language: LanguageModule,
    encoded: Uint8Array | undefined,
  ): SynonymLookup | null {
    return encoded === undefined ? null : synonymModule().storedLookup(encoded, config, language)
  }

  function addIndex(
    indexName: string,
    config: IndexConfig,
    language: LanguageModule,
    analysisStale: boolean,
    awaitedCopyLoad: string | null,
  ): PartitionManager {
    if (indexes.has(indexName)) {
      throw new NarsilError(ErrorCodes.INDEX_ALREADY_EXISTS, `Index "${indexName}" already exists`, {
        indexName,
      })
    }

    const router = createPartitionRouter()
    const partitionCount = config.partitions?.maxPartitions ?? 1
    const vectorIndexes = vectorIndexesFor(indexName, config)
    const manager = createPartitionManager(indexName, config, language, router, partitionCount, vectorIndexes)

    indexes.set(indexName, {
      manager,
      config,
      language,
      searchOptions: {
        bm25Params: config.bm25,
        stopWords: manager.analysis.stopWords,
        customTokenizer: manager.analysis.customTokenizer,
        get synonyms() {
          return manager.synonyms
        },
      },
      vectorIndexes,
      vectorCopies: createHeldVectorCopies(),
      analysisStale,
      awaitedCopyLoad,
    })
    return manager
  }

  function dropIndex(indexName: string): void {
    const entry = requireIndex(indexName)
    for (const vectorIndex of entry.vectorIndexes.values()) {
      vectorIndex.dispose()
    }
    closeHeldVectorCopies(entry.vectorCopies)
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

  function queryContextOf(indexName: string): IndexQueryContext | undefined {
    const entry = indexes.get(indexName)
    if (entry === undefined || entry.awaitedCopyLoad !== null) return undefined
    return {
      manager: entry.manager,
      config: entry.config,
      language: entry.language,
      vectorSearchers: entry.vectorCopies.searchers,
      analysisStale: entry.analysisStale,
    }
  }

  async function execute<T>(action: WorkerAction): Promise<T> {
    if (isSegmentAction(action)) {
      return runSegmentAction(requireIndex(action.indexName), action) as T
    }
    switch (action.type) {
      case 'bootstrap': {
        throw new NarsilError(
          ErrorCodes.CONFIG_INVALID,
          'A bootstrap module loads inside a worker, and the thread that owns this executor imports it directly',
          { moduleUrl: action.moduleUrl },
        )
      }

      case 'serveRequests':
      case 'stopServing': {
        throw new NarsilError(
          ErrorCodes.CONFIG_INVALID,
          'Only a worker thread serves requests, and the thread that owns this executor receives them itself',
        )
      }

      case 'createIndex': {
        const language = getLanguage(action.config.language ?? 'english')
        const manager = addIndex(
          action.indexName,
          action.config,
          language,
          action.analysisStale ?? false,
          action.copyLoad ?? null,
        )
        try {
          manager.replaceSynonyms(lookupOf(action.config, language, action.synonyms))
        } catch (err) {
          dropIndex(action.indexName)
          throw err
        }
        return undefined as T
      }

      case 'copyLoaded': {
        const entry = indexes.get(action.indexName)
        if (entry?.awaitedCopyLoad === action.copyLoad) entry.awaitedCopyLoad = null
        return undefined as T
      }

      case 'dropIndex': {
        dropIndex(action.indexName)
        return undefined as T
      }

      case 'loadVectorCopy': {
        const entry = requireIndex(action.indexName)
        loadHeldVectorCopy(
          entry.vectorCopies,
          entry.manager,
          action.fieldName,
          action.handle,
          action.handles,
          threadSlot,
        )
        return undefined as T
      }

      case 'dropVectorCopy': {
        const entry = indexes.get(action.indexName)
        if (entry !== undefined) dropHeldVectorCopy(entry.vectorCopies, action.fieldName, action.handle)
        return undefined as T
      }

      case 'insertVectorOrdinals': {
        const entry = requireIndex(action.indexName)
        return (await insertIntoHeldGraph(entry.vectorCopies, action.fieldName, action.handle, action.ordinals)) as T
      }

      case 'insert': {
        const entry = requireIndex(action.indexName)
        entry.manager.insert(action.docId, action.document, action.skipClone ? { skipClone: true } : undefined)
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

      case 'query':
      case 'preflight':
        return (await runQueryAction(requireIndex(action.indexName), action)) as T

      case 'replaceSynonyms': {
        const entry = indexes.get(action.indexName)
        if (entry !== undefined) entry.manager.replaceSynonyms(lookupOf(entry.config, entry.language, action.synonyms))
        return undefined as T
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
        entry.manager.resetVectorIndexes(vectorIndexesFor(action.indexName, entry.config))
        entry.vectorIndexes = entry.manager.getVectorIndexes()
        entry.vectorCopies = createHeldVectorCopies()

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
        const heap = readHeapStatistics()
        const heapLimit = heap === null ? null : (heap.configuredLimitBytes ?? heap.limitBytes)
        return { ...usage, heapLimit } as T
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
    queryContextOf,
    holdsVectorField: (indexName, fieldName) => {
      const entry = indexes.get(indexName)
      return entry !== undefined && holdsVectorField(entry.vectorCopies, fieldName)
    },
    heldVectorOf: (indexName, fieldName, docId) => {
      const entry = indexes.get(indexName)
      return entry === undefined ? undefined : heldVectorOf(entry.vectorCopies, fieldName, docId)
    },
    createIndex,
    dropIndex,
    listIndexes,
  }
}
