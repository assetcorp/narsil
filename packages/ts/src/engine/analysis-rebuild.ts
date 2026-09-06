import type { PartitionManager } from '../partitioning/manager'
import type { DurabilityManager } from '../persistence/durability/types'
import type { AnalysisConfig, StaleAnalysis } from '../types/config'
import { emitEngineEvent } from './events'

export interface AnalysisRebuildDeps {
  getManager(indexName: string): PartitionManager | undefined
  desyncIndex(indexName: string): boolean
  resyncIndex(indexName: string, wasPromoted: boolean): Promise<void>
  persistAnalysisRevision(indexName: string): Promise<void>
  emit(payload: {
    indexName: string
    status: 'started' | 'completed' | 'failed'
    partitionsRebuilt: number
    partitionCount: number
    error?: Error
  }): void
}

export type StaleIndex = Omit<StaleAnalysis, 'documentCount'>

export interface AnalysisRebuildCoordinator {
  markStale(index: StaleIndex): void
  clearStale(indexName: string): void
  isStale(indexName: string): boolean
  isRunning(indexName: string): boolean
  review(indexName: string): Promise<void>
  reviewStaleIndexes(): Promise<void>
  rebuild(indexName: string): Promise<void>
}

interface StaleEntry {
  index: StaleIndex
  partitionsRebuilt: number
  run: Promise<void> | null
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, 0)
  })
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export interface AnalysisRebuildWiring {
  config: AnalysisConfig | undefined
  getManager(indexName: string): PartitionManager | undefined
  desyncIndex(indexName: string): boolean
  resyncIndex(indexName: string, wasPromoted: boolean): Promise<void>
  durabilityManager: DurabilityManager | null
  eventHandlers: Map<string, Set<(payload: unknown) => void>>
}

export function wireAnalysisRebuild(wiring: AnalysisRebuildWiring): AnalysisRebuildCoordinator {
  return createAnalysisRebuildCoordinator(wiring.config, {
    getManager: wiring.getManager,
    desyncIndex: wiring.desyncIndex,
    resyncIndex: wiring.resyncIndex,
    async persistAnalysisRevision(indexName: string): Promise<void> {
      const durability = wiring.durabilityManager
      if (durability === null) return
      await durability.persistMetadata(indexName)
      await (durability.checkpointFromMemory?.(indexName) ?? durability.checkpoint(indexName))
    },
    emit(payload) {
      emitEngineEvent(wiring.eventHandlers, 'analysisRebuild', payload)
    },
  })
}

export function createAnalysisRebuildCoordinator(
  config: AnalysisConfig | undefined,
  deps: AnalysisRebuildDeps,
): AnalysisRebuildCoordinator {
  const stale = new Map<string, StaleEntry>()
  const rebuildMode = config?.rebuild ?? 'auto'
  let queue: Promise<void> = Promise.resolve()

  async function rebuildNow(indexName: string, entry: StaleEntry): Promise<void> {
    const manager = deps.getManager(indexName)
    if (manager === undefined) {
      entry.run = null
      return
    }

    const partitionCount = manager.partitionCount
    deps.emit({ indexName, status: 'started', partitionsRebuilt: 0, partitionCount })

    const wasPromoted = deps.desyncIndex(indexName)
    try {
      for (let partitionId = 0; partitionId < manager.partitionCount; partitionId += 1) {
        manager.rebuildTextIndex(partitionId)
        entry.partitionsRebuilt = partitionId + 1
        await yieldToEventLoop()
      }
      stale.delete(indexName)
      await deps.persistAnalysisRevision(indexName)
      await deps.resyncIndex(indexName, wasPromoted)
      deps.emit({
        indexName,
        status: 'completed',
        partitionsRebuilt: entry.partitionsRebuilt,
        partitionCount: manager.partitionCount,
      })
    } catch (err) {
      const error = toError(err)
      stale.set(indexName, entry)
      entry.run = null
      await deps.resyncIndex(indexName, wasPromoted).catch(() => undefined)
      deps.emit({
        indexName,
        status: 'failed',
        partitionsRebuilt: entry.partitionsRebuilt,
        partitionCount,
        error,
      })
      throw error
    }
  }

  function enqueue(indexName: string, entry: StaleEntry): Promise<void> {
    if (entry.run !== null) {
      return entry.run
    }
    const run = queue.then(() => rebuildNow(indexName, entry))
    entry.run = run
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function announce(indexName: string, entry: StaleEntry): Promise<void> {
    const documentCount = deps.getManager(indexName)?.countDocuments() ?? 0
    await config?.onStaleAnalysis?.({ ...entry.index, documentCount }, () => enqueue(indexName, entry))
  }

  async function review(indexName: string, entry: StaleEntry): Promise<void> {
    if (entry.run !== null || deps.getManager(indexName) === undefined) return
    try {
      await announce(indexName, entry)
    } catch (err) {
      deps.emit({
        indexName,
        status: 'failed',
        partitionsRebuilt: 0,
        partitionCount: deps.getManager(indexName)?.partitionCount ?? 0,
        error: toError(err),
      })
    }
    if (rebuildMode === 'auto') {
      void enqueue(indexName, entry).catch(() => undefined)
    }
  }

  return {
    markStale(index: StaleIndex): void {
      const existing = stale.get(index.indexName)
      if (existing !== undefined && existing.run !== null) {
        return
      }
      stale.set(index.indexName, { index, partitionsRebuilt: 0, run: null })
    },

    clearStale(indexName: string): void {
      stale.delete(indexName)
    },

    isStale(indexName: string): boolean {
      return stale.has(indexName)
    },

    isRunning(indexName: string): boolean {
      return stale.get(indexName)?.run !== null && stale.get(indexName)?.run !== undefined
    },

    review(indexName: string): Promise<void> {
      const entry = stale.get(indexName)
      return entry === undefined ? Promise.resolve() : review(indexName, entry)
    },

    async reviewStaleIndexes(): Promise<void> {
      for (const [indexName, entry] of [...stale]) {
        await review(indexName, entry)
      }
    },

    rebuild(indexName: string): Promise<void> {
      const entry = stale.get(indexName)
      if (entry === undefined) {
        return Promise.resolve()
      }
      return enqueue(indexName, entry)
    },
  }
}
