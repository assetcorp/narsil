import { ErrorCodes, NarsilError } from '../errors'
import type { PartitionManager } from '../partitioning/manager'
import type { Rebalancer } from '../partitioning/rebalancer'
import type { PartitionRouter } from '../partitioning/router'
import { createWriteAheadQueue, type WriteAheadQueue } from '../partitioning/write-ahead-queue'
import type { AnyDocument } from '../types/schema'
import type { EventHandler } from './core'
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
  lastAppliedSeqMap: Map<string, Map<number, number>>
  eventHandlers: Map<string, Set<EventHandler>>
  requireIndex: (name: string) => {
    vectorFieldPaths: Set<string>
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

    const entries = waq.drain()
    const appliedSeqs = ctx.lastAppliedSeqMap.get(indexName) ?? new Map<number, number>()
    const rebalanceEntry = ctx.requireIndex(indexName)
    const rebalanceVecIndexes = manager.getVectorIndexes()
    const rebalanceVectorFieldPaths = rebalanceVecIndexes.size > 0 ? rebalanceEntry.vectorFieldPaths : new Set<string>()

    for (const entry of entries) {
      const partitionLastSeq = appliedSeqs.get(0) ?? 0
      if (entry.sequenceNumber <= partitionLastSeq) continue

      try {
        if (entry.action === 'insert' && entry.document) {
          const { partitionDoc, extractedVectors } = prepareDocumentVectors(
            entry.document as Record<string, unknown>,
            rebalanceVectorFieldPaths,
            rebalanceVecIndexes,
          )
          manager.insert(entry.docId, partitionDoc as AnyDocument)
          if (extractedVectors.size > 0) {
            insertDocumentVectors(entry.docId, extractedVectors, rebalanceVecIndexes)
          }
        } else if (entry.action === 'remove') {
          manager.remove(entry.docId)
          removeDocumentVectors(entry.docId, rebalanceVecIndexes)
        } else if (entry.action === 'update' && entry.document) {
          const replayUpdateVectors = new Map<string, Float32Array | null>()
          for (const fieldPath of rebalanceVectorFieldPaths) {
            const newVec = extractVectorFromDoc(entry.document as Record<string, unknown>, fieldPath)
            replayUpdateVectors.set(fieldPath, newVec)
          }
          const replayUpdateDoc =
            replayUpdateVectors.size > 0 ? (structuredClone(entry.document) as AnyDocument) : entry.document
          if (replayUpdateVectors.size > 0) {
            for (const fieldPath of replayUpdateVectors.keys()) {
              deleteNestedValue(replayUpdateDoc as Record<string, unknown>, fieldPath)
            }
          }
          manager.update(entry.docId, replayUpdateDoc)
          for (const [fieldPath, newVec] of replayUpdateVectors) {
            const vecIndex = rebalanceVecIndexes.get(fieldPath)
            if (!vecIndex) continue
            if (newVec === null) {
              if (vecIndex.has(entry.docId)) {
                vecIndex.remove(entry.docId)
              }
            } else {
              const oldVec = vecIndex.getVector(entry.docId)
              if (!vectorsEqual(oldVec, newVec)) {
                vecIndex.remove(entry.docId)
                vecIndex.insert(entry.docId, newVec)
              }
            }
          }
        }
      } catch (replayErr) {
        const isDuplicate = replayErr instanceof NarsilError && replayErr.code === ErrorCodes.DOC_ALREADY_EXISTS
        const isMissing = replayErr instanceof NarsilError && replayErr.code === ErrorCodes.DOC_NOT_FOUND
        if (!isDuplicate && !isMissing) {
          console.warn(`WAQ replay failed for ${entry.action} on doc "${entry.docId}":`, replayErr)
        }
      }
      appliedSeqs.set(0, entry.sequenceNumber)
    }
    ctx.lastAppliedSeqMap.set(indexName, appliedSeqs)
  } finally {
    ctx.rebalancingIndexes.delete(indexName)
    ctx.waqMap.delete(indexName)
  }
}
