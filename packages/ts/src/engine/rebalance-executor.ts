import {
  DEFAULT_MAX_PARTITIONS,
  ErrorCodes,
  emitEngineEvent,
  NarsilError,
  rewriteSpillOf,
} from '#platform/storage-host'
import type { PartitionManager } from '../partitioning/manager'
import { registerCheckpointQueue, releaseCheckpointQueue } from '../partitioning/manager/checkpoint-prefix'
import { createRebalancer } from '../partitioning/rebalancer'
import type { PartitionRouter } from '../partitioning/router'
import { beginDurableRebalance, finishDurableRebalance } from '../partitioning/wal-routing'
import { createWriteAheadQueue, type WriteAheadQueue } from '../partitioning/write-ahead-queue'
import { transitionWalLayout } from '../persistence/durability/layout-transition'
import type { DurabilityManager } from '../persistence/durability/types'
import type { RewriteSpill } from '../persistence/paged/rewrite-spill'
import type { PluginRegistry } from '../plugins/registry'
import type { PendingAnalysisMetadata } from '../types/internal'
import type { IndexConfig } from '../types/schema'
import type { DurableAnalysis, EventHandler } from './core'
import type { WorkerOrchestrator } from './orchestration'
import { bufferPreparedMutation } from './queued-mutation'
import { type DeferHooks, replayQueued } from './rebalance-replay'

export interface RebalanceContext {
  prepareQueuedMutation?: typeof bufferPreparedMutation
  router: PartitionRouter
  waqMap: Map<string, WriteAheadQueue>
  rebalancingIndexes: Set<string>
  rebalanceTargets: Map<string, number>
  eventHandlers: Map<string, Set<EventHandler>>
  pluginRegistry: PluginRegistry
  orchestrator: WorkerOrchestrator
  durabilityManager: DurabilityManager | null
  checkWatermark: (indexName: string) => void
  requireIndex: (name: string) => {
    config: IndexConfig
    vectorFieldPaths: Set<string>
    pendingAnalysis: PendingAnalysisMetadata | null
    durableAnalysis: DurableAnalysis | null
  }
}

export async function executeRebalance(
  manager: PartitionManager,
  indexName: string,
  targetPartitionCount: number,
  ctx: RebalanceContext,
  deferHooks?: DeferHooks,
): Promise<void> {
  if (targetPartitionCount <= 0 || !Number.isInteger(targetPartitionCount)) {
    throw new NarsilError(
      ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
      `Target partition count must be a positive integer, got ${targetPartitionCount}`,
      { targetPartitionCount },
    )
  }

  const entry = ctx.requireIndex(indexName)
  const maxPartitions = entry.config.partitions?.maxPartitions ?? DEFAULT_MAX_PARTITIONS
  if (targetPartitionCount > maxPartitions) {
    throw new NarsilError(
      ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
      `Target partition count (${targetPartitionCount}) is above the maximum of ${maxPartitions} partitions`,
      { targetPartitionCount, maxPartitions },
    )
  }

  if (ctx.rebalancingIndexes.has(indexName)) {
    throw new NarsilError(
      ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
      `Index "${indexName}" is already being rebalanced`,
    )
  }

  const registered = ctx.requireIndex(indexName)
  if (registered.pendingAnalysis !== null || registered.durableAnalysis !== null) {
    throw new NarsilError(
      ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
      `Index "${indexName}" is changing its analysis settings, so try the rebalance again once the change ends`,
      { indexName },
    )
  }

  if (targetPartitionCount === manager.partitionCount) {
    return
  }

  ctx.prepareQueuedMutation = bufferPreparedMutation
  const waq = createWriteAheadQueue()
  const registry = ctx.durabilityManager?.partitionRegistry
  registerCheckpointQueue(manager, waq, registry !== undefined)
  if (registry !== undefined) beginDurableRebalance(manager)
  ctx.waqMap.set(indexName, waq)
  ctx.rebalancingIndexes.add(indexName)
  ctx.rebalanceTargets.set(indexName, targetPartitionCount)
  const wasPromoted = ctx.orchestrator.desyncIndex(indexName)

  let spill: RewriteSpill | null = null
  const oldCount = manager.partitionCount
  try {
    spill = await rewriteSpillOf(ctx.durabilityManager?.rewriteStorage?.(), manager)
    await createRebalancer().rebalance(
      manager,
      targetPartitionCount,
      ctx.router,
      progress => {
        if (progress.phase === 'complete') {
          emitEngineEvent(ctx.eventHandlers, 'partitionRebalance', {
            indexName,
            oldCount,
            newCount: targetPartitionCount,
          })
        }
      },
      spill,
    )

    const announceSplit = async (): Promise<void> => {
      try {
        await ctx.pluginRegistry.runHook('onPartitionSplit', {
          indexName,
          oldPartitionCount: oldCount,
          newPartitionCount: targetPartitionCount,
        })
      } catch (hookErr) {
        console.warn(
          'onPartitionSplit plugin hook failed:',
          hookErr instanceof Error ? hookErr.message : String(hookErr),
        )
      }
    }
    if (deferHooks === undefined) await announceSplit()
    else deferHooks(announceSplit)

    if (registry === undefined) await replayQueued(manager, waq, ctx, undefined, deferHooks)
    else {
      const hooks: Array<() => Promise<void>> = []
      await transitionWalLayout(registry, indexName, manager, () => replayQueued(manager, waq, ctx, hooks, deferHooks))
      for (const hook of hooks) await hook()
    }

    if (ctx.durabilityManager) {
      await (ctx.durabilityManager.checkpointFromMemory?.(indexName) ?? ctx.durabilityManager.checkpoint(indexName))
      await spill?.removeUnread(manager)
      await replayQueued(manager, waq, ctx, undefined, deferHooks)
    }

    await ctx.orchestrator.resyncIndex(indexName, wasPromoted)
    do {
      await replayQueued(manager, waq, ctx, undefined, deferHooks)
    } while (waq.size > 0)
  } catch (err) {
    waq.fail(err)
    await spill?.removeUnread(manager).catch(() => undefined)
    throw err
  }

  ctx.rebalancingIndexes.delete(indexName)
  ctx.rebalanceTargets.delete(indexName)
  ctx.waqMap.delete(indexName)
  waq.markReplayed()
  releaseCheckpointQueue(manager, waq)
  finishDurableRebalance(manager)

  ctx.checkWatermark(indexName)
}
