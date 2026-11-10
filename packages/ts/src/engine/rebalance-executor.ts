import { ErrorCodes, NarsilError } from '../errors'
import { DEFAULT_MAX_PARTITIONS } from '../partitioning/constants'
import type { PartitionManager } from '../partitioning/manager'
import { createRebalancer, type SwapPartitions } from '../partitioning/rebalancer'
import { rewriteSpillOf } from '../partitioning/rewrite-spill-of'
import type { PartitionRouter } from '../partitioning/router'
import { createWriteAheadQueue, type WriteAheadQueue } from '../partitioning/write-ahead-queue'
import type { DurabilityManager } from '../persistence/durability/types'
import type { RewriteSpill } from '../persistence/paged/rewrite-spill'
import type { PluginRegistry } from '../plugins/registry'
import type { PendingAnalysisMetadata } from '../types/internal'
import type { IndexConfig } from '../types/schema'
import type { DurableAnalysis, EventHandler } from './core'
import { emitEngineEvent } from './events'
import type { WorkerOrchestrator } from './orchestration'
import { applyEveryQueuedWrite, type QueuedFollowUp, replayQueued, runFollowUps } from './rebalance-replay'

export interface RebalanceContext {
  router: PartitionRouter
  waqMap: Map<string, WriteAheadQueue>
  rebalancingIndexes: Set<string>
  rebalanceTargets: Map<string, number>
  eventHandlers: Map<string, Set<EventHandler>>
  pluginRegistry: PluginRegistry
  orchestrator: WorkerOrchestrator
  durabilityManager: DurabilityManager | null
  holdDurableWrites: ((indexName: string) => Promise<() => void>) | null
  checkWatermark: (indexName: string) => void
  requireIndex: (name: string) => {
    config: IndexConfig
    vectorFieldPaths: Set<string>
    pendingAnalysis: PendingAnalysisMetadata | null
    durableAnalysis: DurableAnalysis | null
  }
}

interface LoggedLayoutSwitch {
  durable: DurabilityManager
  holdWrites: (indexName: string) => Promise<() => void>
  switchLayout: NonNullable<DurabilityManager['checkpointAfterSwitch']>
  holdCoverage: NonNullable<DurabilityManager['holdCheckpointCoverage']>
}

function loggedLayoutSwitchOf(ctx: RebalanceContext): LoggedLayoutSwitch | null {
  const durable = ctx.durabilityManager
  const holdWrites = ctx.holdDurableWrites
  if (durable === null || holdWrites === null) return null
  const switchLayout = durable.checkpointAfterSwitch?.bind(durable)
  const holdCoverage = durable.holdCheckpointCoverage?.bind(durable)
  if (switchLayout === undefined || holdCoverage === undefined) return null
  return { durable, holdWrites, switchLayout, holdCoverage }
}

function swapWithCheckpoint(
  indexName: string,
  oldCount: number,
  waq: WriteAheadQueue,
  ctx: RebalanceContext,
  logged: LoggedLayoutSwitch,
): SwapPartitions {
  return async (manager, partitions) => {
    const release = await logged.holdWrites(indexName)
    let followUps: QueuedFollowUp[] = []
    try {
      const shrinks = partitions.length < oldCount
      const swapped = await logged.switchLayout(
        indexName,
        () => {
          manager.setPartitions(partitions)
          followUps = applyEveryQueuedWrite(manager, indexName, waq, ctx)
          logged.holdCoverage(indexName, false)
          return true
        },
        shrinks,
      )
      if (!swapped) {
        throw new NarsilError(
          ErrorCodes.INSTANCE_SHUT_DOWN,
          `The engine stopped before it saved the new partition layout of index "${indexName}"`,
          { indexName },
        )
      }
      logged.holdCoverage(indexName, true)
    } finally {
      release()
    }
    await runFollowUps(followUps)
  }
}

function requireRebalanceTarget(indexName: string, targetPartitionCount: number, ctx: RebalanceContext): void {
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

  if (entry.pendingAnalysis !== null || entry.durableAnalysis !== null) {
    throw new NarsilError(
      ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
      `Index "${indexName}" is changing its analysis settings, so try the rebalance again once the change ends`,
      { indexName },
    )
  }
}

async function drainQueue(
  manager: PartitionManager,
  indexName: string,
  waq: WriteAheadQueue,
  ctx: RebalanceContext,
  wasPromoted: boolean,
): Promise<void> {
  await ctx.orchestrator.resyncIndex(indexName, wasPromoted)
  do {
    await replayQueued(manager, indexName, waq, ctx)
  } while (waq.size > 0)
}

export async function executeRebalance(
  manager: PartitionManager,
  indexName: string,
  targetPartitionCount: number,
  ctx: RebalanceContext,
): Promise<void> {
  requireRebalanceTarget(indexName, targetPartitionCount, ctx)
  if (targetPartitionCount === manager.partitionCount) {
    return
  }

  const logged = loggedLayoutSwitchOf(ctx)
  const waq = createWriteAheadQueue()
  ctx.waqMap.set(indexName, waq)
  ctx.rebalancingIndexes.add(indexName)
  ctx.rebalanceTargets.set(indexName, targetPartitionCount)
  logged?.holdCoverage(indexName, true)
  const wasPromoted = ctx.orchestrator.desyncIndex(indexName)

  let spill: RewriteSpill | null = null
  try {
    const oldCount = manager.partitionCount
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
      logged === null ? undefined : swapWithCheckpoint(indexName, oldCount, waq, ctx, logged),
    )

    try {
      await ctx.pluginRegistry.runHook('onPartitionSplit', {
        indexName,
        oldPartitionCount: oldCount,
        newPartitionCount: targetPartitionCount,
      })
    } catch (hookErr) {
      console.warn('onPartitionSplit plugin hook failed:', hookErr instanceof Error ? hookErr.message : String(hookErr))
    }

    await replayQueued(manager, indexName, waq, ctx)

    if (ctx.durabilityManager !== null && logged === null) {
      await ctx.durabilityManager.persistMetadata(indexName)
      await (ctx.durabilityManager.checkpointFromMemory?.(indexName) ?? ctx.durabilityManager.checkpoint(indexName))
    }
    if (ctx.durabilityManager !== null) {
      await spill?.removeUnread(manager)
      await replayQueued(manager, indexName, waq, ctx)
    }

    await drainQueue(manager, indexName, waq, ctx, wasPromoted)
  } catch (err) {
    await spill?.removeUnread(manager).catch(() => undefined)
    try {
      await replayQueued(manager, indexName, waq, ctx)
      await drainQueue(manager, indexName, waq, ctx, wasPromoted)
    } catch (recoveryErr) {
      console.warn(
        `Rebalance failure recovery for index "${indexName}" did not complete:`,
        recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
      )
    }
    throw err
  } finally {
    ctx.rebalancingIndexes.delete(indexName)
    ctx.rebalanceTargets.delete(indexName)
    ctx.waqMap.delete(indexName)
    logged?.holdCoverage(indexName, false)
    waq.markReplayed()
  }

  ctx.checkWatermark(indexName)
}
