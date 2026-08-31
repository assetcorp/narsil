import { ErrorCodes, NarsilError } from '../errors'
import type { PartitionManager } from '../partitioning/manager'
import type { Rebalancer } from '../partitioning/rebalancer'
import type { PartitionRouter } from '../partitioning/router'
import { createWriteAheadQueue, type WAQEntry, type WriteAheadQueue } from '../partitioning/write-ahead-queue'
import type { DurabilityManager } from '../persistence/durability/types'
import type { PluginRegistry } from '../plugins/registry'
import type { AnyDocument, IndexConfig } from '../types/schema'
import type { EventHandler } from './core'
import type { WorkerOrchestrator } from './orchestration'
import {
  deleteNestedValue,
  extractVectorFromDoc,
  insertDocumentVectors,
  prepareDocumentVectors,
  removeDocumentVectors,
  vectorsEqual,
} from './vector-coordinator'

export interface RebalanceContext {
  rebalancer: Rebalancer
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
  }
}

function warnHookError(hook: string, err: unknown): void {
  console.warn(`${hook} plugin hook error:`, err instanceof Error ? err.message : String(err))
}

function applyReplayUpdateVectors(
  entry: WAQEntry,
  vectorFieldPaths: Set<string>,
): { updateDoc: AnyDocument; updateVectors: Map<string, Float32Array | null> } {
  const updateVectors = new Map<string, Float32Array | null>()
  for (const fieldPath of vectorFieldPaths) {
    updateVectors.set(fieldPath, extractVectorFromDoc(entry.document as Record<string, unknown>, fieldPath))
  }
  let updateDoc = entry.document as AnyDocument
  if (updateVectors.size > 0) {
    updateDoc = structuredClone(entry.document) as AnyDocument
    for (const fieldPath of updateVectors.keys()) {
      deleteNestedValue(updateDoc as Record<string, unknown>, fieldPath)
    }
  }
  return { updateDoc, updateVectors }
}

async function replayEntry(
  manager: PartitionManager,
  indexName: string,
  entry: WAQEntry,
  ctx: RebalanceContext,
): Promise<void> {
  const vecIndexes = manager.getVectorIndexes()
  const vectorFieldPaths = ctx.requireIndex(indexName).vectorFieldPaths

  if (entry.action === 'insert' && entry.document) {
    const { partitionDoc, extractedVectors } = prepareDocumentVectors(
      entry.document as Record<string, unknown>,
      vectorFieldPaths,
    )
    const overwrote = manager.has(entry.docId)
    if (overwrote) {
      removeDocumentVectors(entry.docId, vecIndexes)
      manager.remove(entry.docId)
    }
    manager.insert(entry.docId, partitionDoc as AnyDocument)
    if (extractedVectors.size > 0) {
      insertDocumentVectors(entry.docId, extractedVectors, vecIndexes, manager.partitionIdOf(entry.docId))
      for (const fieldPath of extractedVectors.keys()) {
        vecIndexes.get(fieldPath)?.scheduleBuild()
      }
    }
    try {
      await ctx.pluginRegistry.runHook('afterInsert', { indexName, docId: entry.docId, document: entry.document })
    } catch (err) {
      warnHookError('afterInsert', err)
    }
    await ctx.orchestrator.replicateToWorkers({
      type: overwrote ? 'update' : 'insert',
      indexName,
      docId: entry.docId,
      document: entry.document,
      requestId: `replicate-insert-${entry.docId}`,
    })
    return
  }

  if (entry.action === 'remove') {
    manager.remove(entry.docId)
    removeDocumentVectors(entry.docId, vecIndexes)
    try {
      await ctx.pluginRegistry.runHook('afterRemove', { indexName, docId: entry.docId })
    } catch (err) {
      warnHookError('afterRemove', err)
    }
    await ctx.orchestrator.replicateToWorkers({
      type: 'remove',
      indexName,
      docId: entry.docId,
      requestId: `replicate-remove-${entry.docId}`,
    })
    return
  }

  if (entry.action === 'update' && entry.document) {
    const oldDocument = manager.get(entry.docId)
    const { updateDoc, updateVectors } = applyReplayUpdateVectors(entry, vectorFieldPaths)
    if (manager.has(entry.docId)) {
      manager.update(entry.docId, updateDoc)
    } else {
      manager.insert(entry.docId, updateDoc)
    }
    for (const [fieldPath, newVec] of updateVectors) {
      const vecIndex = vecIndexes.get(fieldPath)
      if (!vecIndex) continue
      if (newVec === null) {
        if (vecIndex.has(entry.docId)) {
          vecIndex.remove(entry.docId)
        }
      } else {
        const oldVec = vecIndex.getVector(entry.docId)
        if (!vectorsEqual(oldVec, newVec)) {
          if (vecIndex.has(entry.docId)) {
            vecIndex.remove(entry.docId)
          }
          vecIndex.insert(entry.docId, newVec)
          vecIndex.scheduleBuild()
        }
      }
    }
    try {
      await ctx.pluginRegistry.runHook('afterUpdate', {
        indexName,
        docId: entry.docId,
        oldDocument: oldDocument ?? ({} as AnyDocument),
        newDocument: entry.document,
      })
    } catch (err) {
      warnHookError('afterUpdate', err)
    }
    await ctx.orchestrator.replicateToWorkers({
      type: 'update',
      indexName,
      docId: entry.docId,
      document: entry.document,
      requestId: `replicate-update-${entry.docId}`,
    })
  }
}

async function replayQueued(
  manager: PartitionManager,
  indexName: string,
  waq: WriteAheadQueue,
  ctx: RebalanceContext,
): Promise<void> {
  while (true) {
    const entries = waq.drain()
    if (entries.length === 0) break

    for (const entry of entries) {
      try {
        await replayEntry(manager, indexName, entry, ctx)
      } catch (replayErr) {
        const isMissing = replayErr instanceof NarsilError && replayErr.code === ErrorCodes.DOC_NOT_FOUND
        if (!isMissing) {
          console.warn(`WAQ replay failed for ${entry.action} on doc "${entry.docId}":`, replayErr)
        }
      }
    }
  }
}

export async function executeRebalance(
  manager: PartitionManager,
  indexName: string,
  targetPartitionCount: number,
  ctx: RebalanceContext,
): Promise<void> {
  if (targetPartitionCount <= 0 || !Number.isInteger(targetPartitionCount)) {
    throw new NarsilError(
      ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
      `Target partition count must be a positive integer, got ${targetPartitionCount}`,
      { targetPartitionCount },
    )
  }

  const entry = ctx.requireIndex(indexName)
  const maxPartitions = entry.config.partitions?.maxPartitions
  if (maxPartitions !== undefined && targetPartitionCount > maxPartitions) {
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

  if (targetPartitionCount === manager.partitionCount) {
    return
  }

  const waq = createWriteAheadQueue()
  ctx.waqMap.set(indexName, waq)
  ctx.rebalancingIndexes.add(indexName)
  ctx.rebalanceTargets.set(indexName, targetPartitionCount)
  const wasPromoted = ctx.orchestrator.desyncIndex(indexName)

  try {
    const oldCount = manager.partitionCount
    await ctx.rebalancer.rebalance(manager, targetPartitionCount, ctx.router, progress => {
      if (progress.phase === 'complete') {
        const handlers = ctx.eventHandlers.get('partitionRebalance')
        if (handlers) {
          for (const handler of handlers) {
            handler({ indexName, oldCount, newCount: targetPartitionCount })
          }
        }
      }
    })

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

    if (ctx.durabilityManager) {
      await ctx.durabilityManager.persistMetadata(indexName)
      await ctx.durabilityManager.checkpoint(indexName)
      await replayQueued(manager, indexName, waq, ctx)
    }

    await ctx.orchestrator.resyncIndex(indexName, wasPromoted)
    do {
      await replayQueued(manager, indexName, waq, ctx)
    } while (waq.size > 0)
  } catch (err) {
    try {
      await replayQueued(manager, indexName, waq, ctx)
      await ctx.orchestrator.resyncIndex(indexName, wasPromoted)
      do {
        await replayQueued(manager, indexName, waq, ctx)
      } while (waq.size > 0)
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
  }

  ctx.checkWatermark(indexName)
}
