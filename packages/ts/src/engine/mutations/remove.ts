import {
  awaitWriteVisibility,
  BATCH_CHUNK_SIZE,
  ErrorCodes,
  indexChangeOutsideExternalWaits,
  NarsilError,
  removeDocumentVectors,
  turnIsSpent,
  turnsAreBudgeted,
  validateBatchList,
  validateDocId,
  yieldTurn,
} from '#platform/optional-writes-host'
import type { RemovedSpellings } from '../../core/partition/frozen/surface-slot'
import type { PreparedTextChange } from '../../core/partition/prepared-text'
import type { PartitionManager } from '../../partitioning/manager'
import type { BatchResult } from '../../types/results'
import type { AnyDocument, WriteOptions } from '../../types/schema'
import type { IndexHold } from '../index-hold'
import type { ApplyMutation, MutationContext } from './context'
import { holdVectorsForRollback, rollbackRemovedDocument } from './durable-rollback'
import { runOutside } from './outside-hold'
import { recordChunk } from './record-batch'

interface PreparedRemoval {
  preparedText?: PreparedTextChange
  docId: string
  document: null
  restoreDoc: AnyDocument | undefined
  removedSpellings: RemovedSpellings | undefined
  buffered: boolean
  releaseVectorHolds?: () => void
}

function asRemoveError(err: unknown): NarsilError {
  return err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_NOT_FOUND, String(err))
}

function validateRemoval(ctx: MutationContext, docId: string): void {
  ctx.guardShutdown()
  validateDocId(docId)
}

function prepareRemoval(ctx: MutationContext, indexName: string, docId: string): PreparedRemoval {
  ctx.guardShutdown()
  const rebalancing = ctx.isRebalancing(indexName)
  if (ctx.durability && !rebalancing && !ctx.requireManager(indexName).has(docId)) {
    throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found in any partition`, { docId })
  }

  return {
    docId,
    document: null,
    restoreDoc: undefined,
    removedSpellings: undefined,
    buffered: false,
  }
}

function applyOfRemoval(ctx: MutationContext, indexName: string, prepared: PreparedRemoval): ApplyMutation {
  const { docId } = prepared
  const manager = ctx.requireManager(indexName)
  const removeFromIndex = () => {
    if (ctx.isRebalancing(indexName)) {
      const bufferedState = ctx.bufferedDocState(indexName, docId)
      const exists =
        bufferedState !== undefined ? bufferedState === 'present' : ctx.requireManager(indexName).has(docId)
      if (!exists) {
        throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found in any partition`, { docId })
      }
    }
    const queued = ctx.bufferIfRebalancing(indexName, { action: 'remove', docId, indexName })
    if (queued !== undefined) {
      prepared.buffered = true
      return queued
    }
    prepared.restoreDoc = ctx.durability ? manager.get(docId) : undefined
    if (ctx.durability !== null) prepared.releaseVectorHolds = holdVectorsForRollback(manager.getVectorIndexes(), docId)
    manager.remove(docId, undefined, {
      onRemovedSpellings: spellings => {
        prepared.removedSpellings = spellings
      },
      onPreparedText:
        ctx.durability === null
          ? undefined
          : change => {
              prepared.preparedText = change
            },
    })
    removeDocumentVectors(docId, ctx.requireManager(indexName).getVectorIndexes())
    ctx.orchestrator.publishToWorkers({
      type: 'remove',
      indexName,
      docId,
      requestId: `replicate-remove-${docId}`,
      removedSpellings: prepared.removedSpellings,
    })
  }
  return () => manager.publication.writeNow(indexChangeOutsideExternalWaits(removeFromIndex))
}

async function settleRemovals(
  ctx: MutationContext,
  indexName: string,
  docIds: string[],
  hold: IndexHold | undefined,
): Promise<void> {
  if (docIds.length === 0) return
  const settling = ctx.orchestrator.settlePublications(indexName, 'none')
  if (settling !== undefined) await settling
  if (!ctx.pluginRegistry.hasHooks('afterRemove')) return
  await runOutside(hold, async () => {
    for (const docId of docIds) {
      try {
        await ctx.pluginRegistry.runHook('afterRemove', { indexName, docId })
      } catch (err) {
        console.warn('afterRemove plugin hook error:', err instanceof Error ? err.message : String(err))
      }
    }
  })
}

export async function removeDocument(
  ctx: MutationContext,
  indexName: string,
  docId: string,
  options?: WriteOptions,
  hold?: IndexHold,
): Promise<void> {
  ctx.guardShutdown()
  ctx.requireIndex(indexName)
  validateRemoval(ctx, docId)
  if (ctx.pluginRegistry.hasHooks('beforeRemove')) {
    await runOutside(hold, async () => {
      await ctx.pluginRegistry.runHook('beforeRemove', { indexName, docId })
    })
  }
  const prepared = prepareRemoval(ctx, indexName, docId)
  const apply = applyOfRemoval(ctx, indexName, prepared)

  if (ctx.durability) {
    try {
      await ctx.durability.recordRemove(indexName, docId, apply)
    } catch (err) {
      await rollbackRemovedDocument(ctx, indexName, docId, prepared.restoreDoc, err, prepared.preparedText)
      throw err
    } finally {
      prepared.releaseVectorHolds?.()
    }
  } else {
    await apply()
  }

  if (!prepared.buffered) await settleRemovals(ctx, indexName, [docId], hold)
  if (options?.wait === true) await awaitWriteVisibility(ctx, indexName)
}

async function refusedRemovalsOf(
  ctx: MutationContext,
  indexName: string,
  docIds: string[],
  chunkStart: number,
  chunkEnd: number,
  hold: IndexHold | undefined,
): Promise<Map<number, unknown>> {
  const refused = new Map<number, unknown>()
  for (let i = chunkStart; i < chunkEnd; i++) {
    try {
      validateRemoval(ctx, docIds[i])
    } catch (err) {
      refused.set(i, err)
    }
  }
  if (!ctx.pluginRegistry.hasHooks('beforeRemove')) return refused
  await runOutside(hold, async () => {
    for (let i = chunkStart; i < chunkEnd; i++) {
      if (refused.has(i)) continue
      try {
        await ctx.pluginRegistry.runHook('beforeRemove', { indexName, docId: docIds[i] })
      } catch (err) {
        refused.set(i, err)
      }
    }
  })
  return refused
}

export async function removeDocumentBatch(
  ctx: MutationContext,
  indexName: string,
  docIds: string[],
  options?: WriteOptions,
  hold?: IndexHold,
): Promise<BatchResult> {
  ctx.guardShutdown()
  ctx.requireIndex(indexName)
  validateBatchList(docIds, 'document IDs')

  const succeeded: string[] = []
  const failed: BatchResult['failed'] = []
  const first = ctx.requireManager(indexName)
  await first.publication.write(() => first.beginBatchRemove())
  let manager: PartitionManager | undefined = first

  try {
    for (let chunkStart = 0; chunkStart < docIds.length; chunkStart += BATCH_CHUNK_SIZE) {
      const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, docIds.length)
      const refused = await refusedRemovalsOf(ctx, indexName, docIds, chunkStart, chunkEnd, hold)
      manager = await batchManagerAfterHooks(ctx, indexName, manager)
      const removed: string[] = []
      const prepared: PreparedRemoval[] = []
      for (let i = chunkStart; i < chunkEnd; i++) {
        if (turnsAreBudgeted && turnIsSpent()) await yieldTurn()
        try {
          if (refused.has(i)) throw refused.get(i)
          prepared.push(prepareRemoval(ctx, indexName, docIds[i]))
        } catch (err) {
          failed.push({ docId: docIds[i], error: asRemoveError(err) })
        }
      }

      const applies = prepared.map(removal => applyOfRemoval(ctx, indexName, removal))
      try {
        const failures = await recordChunk(ctx, indexName, prepared, applies)
        for (let i = 0; i < prepared.length; i++) {
          const removal = prepared[i]
          const failure = failures[i]
          if (failure !== null) {
            let error = failure.error
            try {
              await rollbackRemovedDocument(
                ctx,
                indexName,
                removal.docId,
                removal.restoreDoc,
                error,
                removal.preparedText,
              )
            } catch (rollbackError) {
              error = rollbackError
            }
            removal.releaseVectorHolds?.()
            failed.push({ docId: removal.docId, error: asRemoveError(error) })
            continue
          }
          removal.releaseVectorHolds?.()
          if (!removal.buffered) removed.push(removal.docId)
          succeeded.push(removal.docId)
        }
      } finally {
        for (const removal of prepared) removal.releaseVectorHolds?.()
      }
      await settleRemovals(ctx, indexName, removed, hold)
      manager = await batchManagerAfterHooks(ctx, indexName, manager)

      if (chunkEnd < docIds.length) {
        await new Promise<void>(r => setTimeout(r, 0))
      }
    }
  } finally {
    const ending = manager
    await ending?.publication.write(() => ending.endBatchRemove())
  }
  ctx.checkHeapPressure(indexName)
  if (options?.wait === true) await awaitWriteVisibility(ctx, indexName)

  return { succeeded, failed }
}

async function batchManagerAfterHooks(
  ctx: MutationContext,
  indexName: string,
  batchManager: PartitionManager | undefined,
): Promise<PartitionManager | undefined> {
  const current = ctx.executor.getManager(indexName)
  if (current === batchManager) return batchManager
  await batchManager?.publication.write(() => batchManager.endBatchRemove())
  await current?.publication.write(() => current.beginBatchRemove())
  return current
}
