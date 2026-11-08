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
import type { BatchResult } from '../../types/results'
import type { AnyDocument, WriteOptions } from '../../types/schema'
import type { ApplyMutation, MutationContext } from './context'
import { rollbackRemovedDocument } from './durable-rollback'
import { recordChunk } from './record-batch'

interface PreparedRemoval {
  preparedText?: PreparedTextChange
  docId: string
  document: null
  restoreDoc: AnyDocument | undefined
  removedSpellings: RemovedSpellings | undefined
  buffered: boolean
}

function asRemoveError(err: unknown): NarsilError {
  return err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_NOT_FOUND, String(err))
}

async function prepareRemoval(ctx: MutationContext, indexName: string, docId: string): Promise<PreparedRemoval> {
  ctx.guardShutdown()
  validateDocId(docId)
  await ctx.pluginRegistry.runHook('beforeRemove', { indexName, docId })

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
    prepared.removedSpellings = manager.removedSpellingsOf(docId)
    manager.remove(docId, prepared.removedSpellings, {
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
  return () => manager.publication.write(indexChangeOutsideExternalWaits(removeFromIndex))
}

async function settleRemoval(ctx: MutationContext, indexName: string, prepared: PreparedRemoval): Promise<void> {
  await ctx.orchestrator.settlePublications(indexName)
  const { docId } = prepared
  try {
    await ctx.pluginRegistry.runHook('afterRemove', { indexName, docId })
  } catch (err) {
    console.warn('afterRemove plugin hook error:', err instanceof Error ? err.message : String(err))
  }
}

export async function removeDocument(
  ctx: MutationContext,
  indexName: string,
  docId: string,
  options?: WriteOptions,
): Promise<void> {
  ctx.guardShutdown()
  ctx.requireIndex(indexName)
  const prepared = await prepareRemoval(ctx, indexName, docId)
  const apply = applyOfRemoval(ctx, indexName, prepared)

  if (ctx.durability) {
    try {
      await ctx.durability.recordRemove(indexName, docId, apply)
    } catch (err) {
      await rollbackRemovedDocument(ctx, indexName, docId, prepared.restoreDoc, err, prepared.preparedText)
      throw err
    }
  } else {
    await apply()
  }

  if (!prepared.buffered) await settleRemoval(ctx, indexName, prepared)
  if (options?.wait === true) await awaitWriteVisibility(ctx, indexName)
}

export async function removeDocumentBatch(
  ctx: MutationContext,
  indexName: string,
  docIds: string[],
  options?: WriteOptions,
): Promise<BatchResult> {
  ctx.guardShutdown()
  ctx.requireIndex(indexName)
  validateBatchList(docIds, 'document IDs')

  const succeeded: string[] = []
  const failed: BatchResult['failed'] = []
  const manager = ctx.requireManager(indexName)
  await manager.publication.write(() => manager.beginBatchRemove())

  try {
    for (let chunkStart = 0; chunkStart < docIds.length; chunkStart += BATCH_CHUNK_SIZE) {
      const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, docIds.length)
      const prepared: PreparedRemoval[] = []
      for (let i = chunkStart; i < chunkEnd; i++) {
        if (turnsAreBudgeted && turnIsSpent()) await yieldTurn()
        try {
          prepared.push(await prepareRemoval(ctx, indexName, docIds[i]))
        } catch (err) {
          failed.push({ docId: docIds[i], error: asRemoveError(err) })
        }
      }

      const applies = prepared.map(removal => applyOfRemoval(ctx, indexName, removal))
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
          failed.push({ docId: removal.docId, error: asRemoveError(error) })
          continue
        }
        if (!removal.buffered) await settleRemoval(ctx, indexName, removal)
        succeeded.push(removal.docId)
      }

      if (chunkEnd < docIds.length) {
        await new Promise<void>(r => setTimeout(r, 0))
      }
    }
  } finally {
    await manager.publication.write(() => manager.endBatchRemove())
  }
  ctx.checkHeapPressure(indexName)
  if (options?.wait === true) await awaitWriteVisibility(ctx, indexName)

  return { succeeded, failed }
}
