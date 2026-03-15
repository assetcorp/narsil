import { ErrorCodes, NarsilError } from '../errors'
import { getLanguage } from '../languages/registry'
import { fanOutQuery } from '../partitioning/fan-out'
import { createPartitionManager, type PartitionManager } from '../partitioning/manager'
import { createPartitionRouter } from '../partitioning/router'
import type { LanguageModule } from '../types/language'
import type { IndexConfig } from '../types/schema'
import type { Executor } from './executor'
import type { WorkerAction } from './protocol'

export interface DirectExecutorExtensions {
  getManager(indexName: string): PartitionManager | undefined
  createIndex(indexName: string, config: IndexConfig, language: LanguageModule): void
  dropIndex(indexName: string): void
  listIndexes(): string[]
}

interface IndexEntry {
  manager: PartitionManager
  config: IndexConfig
  language: LanguageModule
}

export function createDirectExecutor(): Executor & DirectExecutorExtensions {
  const indexes = new Map<string, IndexEntry>()

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
    const manager = createPartitionManager(indexName, config, language, router, partitionCount)

    indexes.set(indexName, { manager, config, language })
  }

  function dropIndex(indexName: string): void {
    const entry = requireIndex(indexName)
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
        entry.manager.insert(action.docId, action.document)
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
        const result = fanOutQuery(entry.manager, action.params, entry.language, entry.config.schema, {
          scoringMode: entry.config.defaultScoring ?? 'local',
        })
        return result as T
      }

      case 'preflight': {
        const entry = requireIndex(action.indexName)
        const result = fanOutQuery(entry.manager, action.params, entry.language, entry.config.schema, {
          scoringMode: entry.config.defaultScoring ?? 'local',
        })
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
        return undefined as T
      }

      case 'serialize': {
        const entry = requireIndex(action.indexName)
        return entry.manager.serializePartition(action.partitionId) as T
      }

      case 'deserialize': {
        const entry = requireIndex(action.indexName)
        entry.manager.deserializePartition(action.partitionId, action.data)
        return undefined as T
      }

      case 'memoryReport': {
        const report = typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage() : {}
        return report as T
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
