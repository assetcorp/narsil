import type { PartitionManager } from '../partitioning/manager'
import { rebuildTextIndexes } from '../partitioning/text-rebuild'
import type { DurabilityManager } from '../persistence/durability/types'
import type { RewriteSpill, RewriteStorage } from '../persistence/paged/rewrite-spill'
import type { AnalysisConfig, StaleAnalysis } from '../types/config'
import { emitEngineEvent } from './events'

export interface AnalysisRebuildDeps {
  getManager(indexName: string): PartitionManager | undefined
  rewriteStorage?(): RewriteStorage | undefined
  desyncIndex(indexName: string): boolean
  resyncIndex(indexName: string, wasPromoted: boolean): Promise<void>
  persistAnalysisRevision(indexName: string): Promise<void>
  hasPendingChange(indexName: string): boolean
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
  readonly rebuildMode: 'auto' | 'manual'
  markStale(index: StaleIndex): void
  clearStale(indexName: string): void
  isStale(indexName: string): boolean
  isRunning(indexName: string): boolean
  review(indexName: string): Promise<void>
  reviewStaleIndexes(): Promise<void>
  rebuild(indexName: string): Promise<void>
  abandon(indexName: string): Promise<void>
  runExclusive<T>(indexName: string, work: () => Promise<T>, turnEnds?: Promise<void>): Promise<T>
}

interface StaleEntry {
  index: StaleIndex
  partitionsRebuilt: number
  run: Promise<void> | null
  abandoned: boolean
}

interface ActiveRebuild {
  indexName: string
  entry: StaleEntry
  done: Promise<void>
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export interface AnalysisRebuildWiring {
  config: AnalysisConfig | undefined
  getManager(indexName: string): PartitionManager | undefined
  desyncIndex(indexName: string): boolean
  resyncIndex(indexName: string, wasPromoted: boolean): Promise<void>
  recordCurrentAnalysis(indexName: string): void
  hasPendingChange(indexName: string): boolean
  durabilityManager: DurabilityManager | null
  eventHandlers: Map<string, Set<(payload: unknown) => void>>
}

export function wireAnalysisRebuild(wiring: AnalysisRebuildWiring): AnalysisRebuildCoordinator {
  return createAnalysisRebuildCoordinator(wiring.config, {
    getManager: wiring.getManager,
    rewriteStorage: () => wiring.durabilityManager?.rewriteStorage?.(),
    desyncIndex: wiring.desyncIndex,
    resyncIndex: wiring.resyncIndex,
    hasPendingChange: wiring.hasPendingChange,
    async persistAnalysisRevision(indexName: string): Promise<void> {
      const durability = wiring.durabilityManager
      if (durability === null) {
        wiring.recordCurrentAnalysis(indexName)
        return
      }
      await (durability.checkpointFromMemory?.(indexName) ?? durability.checkpoint(indexName))
      wiring.recordCurrentAnalysis(indexName)
      await durability.persistMetadata(indexName)
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
  const exclusiveRuns = new Map<string, number>()
  const rebuildMode = config?.rebuild ?? 'auto'
  let queue: Promise<void> = Promise.resolve()
  let active: ActiveRebuild | null = null

  async function rebuildNow(indexName: string, entry: StaleEntry): Promise<void> {
    const manager = deps.getManager(indexName)
    if (manager === undefined || entry.abandoned) {
      entry.run = null
      return
    }

    const partitionCount = manager.partitionCount
    deps.emit({ indexName, status: 'started', partitionsRebuilt: 0, partitionCount })

    const wasPromoted = deps.desyncIndex(indexName)
    let spill: RewriteSpill | null = null
    try {
      const rebuilt = await rebuildTextIndexes(manager, {
        rewriteStorage: () => deps.rewriteStorage?.(),
        onRewriteSpill(kept) {
          spill = kept
        },
        isCurrent: () => deps.getManager(indexName) === manager && stale.get(indexName) === entry && !entry.abandoned,
        onPartitionBuilt(partitionsBuilt) {
          entry.partitionsRebuilt = partitionsBuilt
        },
        onSwitch() {
          stale.delete(indexName)
        },
      })
      if (!rebuilt) {
        entry.run = null
        if (deps.getManager(indexName) === manager) await deps.resyncIndex(indexName, wasPromoted)
        return
      }
      await deps.persistAnalysisRevision(indexName)
      await (spill as RewriteSpill | null)?.removeUnread(manager)
      await deps.resyncIndex(indexName, wasPromoted)
      deps.emit({
        indexName,
        status: 'completed',
        partitionsRebuilt: entry.partitionsRebuilt,
        partitionCount: manager.partitionCount,
      })
    } catch (err) {
      const error = toError(err)
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

  function runTracked(indexName: string, entry: StaleEntry): Promise<void> {
    const done = rebuildNow(indexName, entry)
    const tracked: ActiveRebuild = { indexName, entry, done }
    active = tracked
    return done.finally(() => {
      if (active === tracked) active = null
    })
  }

  function enqueue(indexName: string, entry: StaleEntry): Promise<void> {
    if (entry.run !== null) {
      return entry.run
    }
    entry.abandoned = false
    const run = queue.then(() => runTracked(indexName, entry))
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
    if (entry.run !== null || deps.getManager(indexName) === undefined || deps.hasPendingChange(indexName)) return
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
    rebuildMode,

    markStale(index: StaleIndex): void {
      const existing = stale.get(index.indexName)
      if (existing !== undefined && existing.run !== null) {
        return
      }
      stale.set(index.indexName, { index, partitionsRebuilt: 0, run: null, abandoned: false })
    },

    clearStale(indexName: string): void {
      stale.delete(indexName)
    },

    isStale(indexName: string): boolean {
      return stale.has(indexName)
    },

    isRunning(indexName: string): boolean {
      if ((exclusiveRuns.get(indexName) ?? 0) > 0) return true
      return stale.get(indexName)?.run !== null && stale.get(indexName)?.run !== undefined
    },

    runExclusive<T>(indexName: string, work: () => Promise<T>, turnEnds?: Promise<void>): Promise<T> {
      exclusiveRuns.set(indexName, (exclusiveRuns.get(indexName) ?? 0) + 1)
      const run = queue.then(work).finally(() => {
        const remaining = (exclusiveRuns.get(indexName) ?? 1) - 1
        if (remaining === 0) exclusiveRuns.delete(indexName)
        else exclusiveRuns.set(indexName, remaining)
      })
      queue = Promise.race([run, turnEnds ?? run]).then(
        () => undefined,
        () => undefined,
      )
      return run
    },

    async abandon(indexName: string): Promise<void> {
      const entry = stale.get(indexName)
      if (entry !== undefined && entry.run !== null) entry.abandoned = true
      const running = active
      if (running === null || running.indexName !== indexName) return
      running.entry.abandoned = true
      await running.done.catch(() => undefined)
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
