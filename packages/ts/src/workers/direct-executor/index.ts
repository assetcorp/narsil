import { readHeapStatistics } from '#platform/heap-statistics'
import { loadSegmentMerge } from '../../core/segment-merge-code'
import { synonymModule } from '../../core/synonyms/registry'
import type { SynonymLookup } from '../../core/synonyms/types'
import { ErrorCodes, NarsilError } from '../../errors'
import { getLanguage } from '../../languages/registry'
import { createPartitionManager, type PartitionManager } from '../../partitioning/manager'
import { createPartitionRouter } from '../../partitioning/router'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig, VectorStorageMode } from '../../types/schema'
import type { VectorWorkerCopyPolicy } from '../../vector/vector-index'
import type { Executor } from '../executor'
import type { WorkerAction } from '../protocol'
import { loadSchemaCodeFor } from '../schema-code'
import { growPartitionsTo, isSegmentAction, runSegmentAction } from '../segment-action-code'
import { loadedVectorCode, loadVectorCode } from '../vector-code'
import {
  closeHeldVectorCopies,
  createHeldVectorCopies,
  dropHeldVectorCopy,
  heldVectorOf,
  holdsVectorField,
  insertIntoHeldGraph,
  loadHeldVectorCopy,
  pinHeldVectorField,
} from '../vector-copies'
import { disposeEntry, indexEntryOf, queryContextOfEntry, vectorIndexesFor } from './entry'
import type {
  DetachedIndex,
  DirectExecutorExtensions,
  DirectExecutorOptions,
  IndexEntry,
  IndexQueryContext,
  IndexReplacement,
} from './types'

export type {
  DetachedIndex,
  DirectExecutorExtensions,
  DirectExecutorOptions,
  IndexEntry,
  IndexQueryContext,
  IndexReplacement,
} from './types'

const NO_VECTOR_WORKER_COPIES: VectorWorkerCopyPolicy = { enabled: false }

export function createDirectExecutor(
  options?: DirectExecutorOptions,
): Executor & DirectExecutorExtensions & IndexReplacement {
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

  function createIndex(
    indexName: string,
    config: IndexConfig,
    language: LanguageModule,
    analysisStale = false,
    synonyms: SynonymLookup | null = null,
    partitionCount?: number,
  ): void {
    addIndex(indexName, config, language, analysisStale, null, partitionCount).synonyms = synonyms
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
    savedPartitionCount: number | undefined,
  ): PartitionManager {
    if (indexes.has(indexName)) {
      throw new NarsilError(ErrorCodes.INDEX_ALREADY_EXISTS, `Index "${indexName}" already exists`, {
        indexName,
      })
    }

    const entry = buildEntry(
      indexName,
      config,
      language,
      analysisStale,
      awaitedCopyLoad,
      vectorWorkerCopies,
      savedPartitionCount,
    )
    indexes.set(indexName, entry)
    return entry.manager
  }

  function buildEntry(
    indexName: string,
    config: IndexConfig,
    language: LanguageModule,
    analysisStale: boolean,
    awaitedCopyLoad: string | null,
    copies: VectorWorkerCopyPolicy,
    savedPartitionCount: number | undefined,
  ): IndexEntry {
    const router = createPartitionRouter()
    const partitionCount = savedPartitionCount ?? config.partitions?.maxPartitions ?? 1
    const vectorIndexes = vectorIndexesFor(indexName, config, copies, vectorStorage, options?.onVectorGraphRepaired)
    const manager = createPartitionManager(indexName, config, language, router, partitionCount, vectorIndexes)

    return indexEntryOf(manager, vectorIndexes, analysisStale, awaitedCopyLoad)
  }

  async function dropIndex(indexName: string): Promise<void> {
    const entry = requireIndex(indexName)
    indexes.delete(indexName)
    await disposeEntry(entry)
  }

  async function installDetachedIndex(detached: DetachedIndex): Promise<void> {
    const previous = indexes.get(detached.indexName)
    indexes.set(detached.indexName, detached.entry)
    if (previous !== undefined && previous !== detached.entry) await disposeEntry(previous)
  }

  function listIndexes(): string[] {
    return Array.from(indexes.keys())
  }

  function getManager(indexName: string): PartitionManager | undefined {
    return indexes.get(indexName)?.manager
  }

  function queryContextOf(indexName: string): IndexQueryContext | undefined {
    return queryContextOfEntry(indexes.get(indexName))
  }

  function execute<T>(action: WorkerAction): Promise<T> {
    if (options?.publishCopyAction === undefined) return executeAction<T>(action)
    const entry = 'indexName' in action ? indexes.get(action.indexName) : undefined
    if (entry === undefined) return executeAction<T>(action)
    return options.publishCopyAction(
      action,
      entry,
      threadSlot,
      () => 'indexName' in action && indexes.get(action.indexName) === entry,
      () => executeAction<T>(action),
    )
  }

  async function executeAction<T>(action: WorkerAction): Promise<T> {
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
      case 'serveLongQueries':
      case 'stopServing': {
        throw new NarsilError(
          ErrorCodes.CONFIG_INVALID,
          'Only a worker thread serves requests, and the thread that owns this executor receives them itself',
        )
      }

      case 'createIndex': {
        const loading = loadSchemaCodeFor(action.config.schema, action.config.tokenizer)
        if (loading !== null) await loading
        const language = getLanguage(action.config.language ?? 'english')
        const manager = addIndex(
          action.indexName,
          action.config,
          language,
          action.analysisStale ?? false,
          action.copyLoad ?? null,
          action.partitionCount,
        )
        try {
          manager.synonyms = lookupOf(action.config, language, action.synonyms)
          if (action.publication !== undefined) {
            const entry = requireIndex(action.indexName)
            options?.initializeCopyPublication?.(entry, action.publication, threadSlot)
          }
        } catch (err) {
          await dropIndex(action.indexName)
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
        await dropIndex(action.indexName)
        return undefined as T
      }

      case 'loadVectorCopy': {
        if (loadedVectorCode() === null) await loadVectorCode()
        const entry = requireIndex(action.indexName)
        loadHeldVectorCopy(
          entry.vectorCopies,
          entry.manager,
          action.fieldName,
          action.handle,
          action.handles,
          threadSlot,
          action.storeHandle,
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
        entry.manager.remove(action.docId, action.removedSpellings)
        return undefined as T
      }

      case 'update': {
        const entry = requireIndex(action.indexName)
        if (action.publication !== undefined && !entry.manager.has(action.docId))
          entry.manager.insert(action.docId, action.document)
        else entry.manager.update(action.docId, action.document, undefined, action.removedSpellings)
        return undefined as T
      }

      case 'query':
      case 'preflight': {
        const runQueryAction = options?.runQueryAction
        if (runQueryAction === undefined) {
          throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Only a worker thread answers query actions', {
            action: action.type,
          })
        }
        const entry = requireIndex(action.indexName)
        return (await runQueryAction(entry, action, () => indexes.get(action.indexName) === entry)) as T
      }

      case 'replaceSynonyms': {
        const entry = indexes.get(action.indexName)
        if (entry !== undefined) entry.manager.synonyms = lookupOf(entry.config, entry.language, action.synonyms)
        return undefined as T
      }

      case 'replaceBm25': {
        const entry = indexes.get(action.indexName)
        if (entry !== undefined) entry.config.bm25 = action.bm25
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
        entry.manager.clearPartitions()
        await entry.manager.resetVectorIndexes(
          vectorIndexesFor(
            action.indexName,
            entry.config,
            vectorWorkerCopies,
            vectorStorage,
            options?.onVectorGraphRepaired,
          ),
        )
        entry.vectorIndexes = entry.manager.getVectorIndexes()
        if (action.publication === undefined) {
          closeHeldVectorCopies(entry.vectorCopies)
          entry.vectorCopies = createHeldVectorCopies()
        }

        return undefined as T
      }

      case 'serialize': {
        const { serializePartition } = await loadSegmentMerge()
        return requireIndex(action.indexName).manager.serializePartition(action.partitionId, serializePartition) as T
      }

      case 'deserialize': {
        const { deserializePartition } = await loadSegmentMerge()
        const entry = requireIndex(action.indexName)
        growPartitionsTo(entry.manager, action.partitionId)
        entry.manager.deserializePartition(action.partitionId, action.data, deserializePartition)
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
          await entry.manager.publication.write(() => disposeEntry(entry))
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
    pinVectorField: (indexName, fieldName) => {
      const entry = indexes.get(indexName)
      return entry === undefined ? undefined : pinHeldVectorField(entry.vectorCopies, fieldName)
    },
    createIndex,
    dropIndex,
    listIndexes,
    vectorWorkerCopies,
    createDetachedEntry: (indexName, config, language, copies, partitionCount) =>
      buildEntry(indexName, config, language, false, null, copies, partitionCount),
    installDetachedIndex,
    discardDetachedIndex: detached => disposeEntry(detached.entry),
  }
}
