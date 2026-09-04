import { generateId } from '../core/id-generator'
import { ErrorCodes, NarsilError } from '../errors'
import { mergePartitionStats } from '../partitioning/distributed-scoring'
import type { PartitionManager } from '../partitioning/manager'
import type { InvalidationAdapter, InvalidationEvent, PartitionStatistics } from '../types/adapters'
import type { NarsilConfig } from '../types/config'
import type { GlobalStatistics } from '../types/internal'
import { FOREIGN_STATS_TTL_MS, STATISTICS_BROADCAST_INTERVAL_MS } from './constants'

export interface InvalidationIntegrationDeps {
  adapter: InvalidationAdapter
  instanceId: string
  reloadIndex: (indexName: string) => Promise<void>
  getManager: (indexName: string) => PartitionManager | undefined
  listBroadcastIndexNames: () => string[]
  onError: (error: Error) => void
}

export interface InvalidationIntegration {
  readonly instanceId: string
  publishPartitions(indexName: string, partitions: number[]): Promise<void>
  broadcastStats(indexName: string): GlobalStatistics | undefined
  start(): Promise<void>
  shutdown(): Promise<void>
}

export type EngineInvalidationDeps = Omit<InvalidationIntegrationDeps, 'adapter' | 'instanceId'>

export function createInvalidationFromConfig(
  config: NarsilConfig | undefined,
  tierKind: 'wal' | 'snapshot' | null,
  deps: EngineInvalidationDeps,
): InvalidationIntegration | null {
  if (config?.invalidation === undefined) {
    return null
  }
  if (tierKind !== 'snapshot') {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Invalidation requires a shared persistence adapter. The write-ahead log tier owns its directory exclusively, so configure a non-filesystem persistence adapter to share data between instances',
    )
  }
  return createInvalidationIntegration({
    adapter: config.invalidation,
    instanceId: generateId(),
    ...deps,
  })
}

interface ForeignStatsEntry {
  stats: PartitionStatistics
  receivedAt: number
}

export function createInvalidationIntegration(deps: InvalidationIntegrationDeps): InvalidationIntegration {
  const { adapter, instanceId, reloadIndex, getManager, listBroadcastIndexNames, onError } = deps

  const foreignStats = new Map<string, Map<string, ForeignStatsEntry>>()
  const reloadChains = new Map<string, Promise<void>>()
  let broadcastTimer: ReturnType<typeof setInterval> | null = null
  let stopped = false

  function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err))
  }

  function pruneStaleForeignStats(entries: Map<string, ForeignStatsEntry>): void {
    const cutoff = Date.now() - FOREIGN_STATS_TTL_MS
    for (const [sourceInstanceId, entry] of entries) {
      if (entry.receivedAt < cutoff) {
        entries.delete(sourceInstanceId)
      }
    }
  }

  function scheduleReload(indexName: string): void {
    const chain = reloadChains.get(indexName) ?? Promise.resolve()
    const next = chain.then(() => reloadIndex(indexName)).catch(err => onError(toError(err)))
    reloadChains.set(indexName, next)
  }

  function storeForeignStats(indexName: string, sourceInstanceId: string, stats: PartitionStatistics): void {
    let entries = foreignStats.get(indexName)
    if (entries === undefined) {
      entries = new Map<string, ForeignStatsEntry>()
      foreignStats.set(indexName, entries)
    }
    entries.set(sourceInstanceId, { stats, receivedAt: Date.now() })
    pruneStaleForeignStats(entries)
  }

  function handleEvent(event: InvalidationEvent): void {
    try {
      if (event.type === 'partition') {
        if (event.sourceInstanceId === instanceId) {
          return
        }
        scheduleReload(event.indexName)
        return
      }
      if (event.instanceId === instanceId) {
        return
      }
      storeForeignStats(event.indexName, event.instanceId, event.stats)
    } catch (err) {
      onError(toError(err))
    }
  }

  async function publishOwnStatistics(): Promise<void> {
    for (const indexName of listBroadcastIndexNames()) {
      const manager = getManager(indexName)
      if (manager === undefined) {
        continue
      }
      const aggregate = manager.getAggregateStats()
      try {
        await adapter.publish({
          type: 'statistics',
          indexName,
          instanceId,
          stats: {
            totalDocs: aggregate.totalDocuments,
            docFrequencies: aggregate.docFrequencies,
            totalFieldLengths: aggregate.totalFieldLengths,
          },
        })
      } catch (err) {
        onError(toError(err))
      }
    }
  }

  return {
    instanceId,

    async publishPartitions(indexName: string, partitions: number[]): Promise<void> {
      if (stopped || partitions.length === 0) {
        return
      }
      try {
        await adapter.publish({
          type: 'partition',
          indexName,
          partitions,
          timestamp: Date.now(),
          sourceInstanceId: instanceId,
        })
      } catch (err) {
        onError(toError(err))
      }
    },

    broadcastStats(indexName: string): GlobalStatistics | undefined {
      const manager = getManager(indexName)
      if (manager === undefined) {
        return undefined
      }
      const own = manager.getAggregateStats()
      const entries = foreignStats.get(indexName)
      if (entries === undefined || entries.size === 0) {
        return mergePartitionStats([own])
      }
      pruneStaleForeignStats(entries)
      const combined = [own]
      for (const [, entry] of entries) {
        combined.push({
          totalDocuments: entry.stats.totalDocs,
          docFrequencies: entry.stats.docFrequencies,
          totalFieldLengths: entry.stats.totalFieldLengths,
        })
      }
      return mergePartitionStats(combined)
    },

    async start(): Promise<void> {
      await adapter.subscribe(handleEvent)
      if (broadcastTimer !== null || stopped) {
        return
      }
      broadcastTimer = setInterval(() => {
        void publishOwnStatistics()
      }, STATISTICS_BROADCAST_INTERVAL_MS)
      if (typeof broadcastTimer.unref === 'function') {
        broadcastTimer.unref()
      }
    },

    async shutdown(): Promise<void> {
      stopped = true
      if (broadcastTimer !== null) {
        clearInterval(broadcastTimer)
        broadcastTimer = null
      }
      try {
        await adapter.shutdown()
      } catch (err) {
        onError(toError(err))
      }
    },
  }
}
