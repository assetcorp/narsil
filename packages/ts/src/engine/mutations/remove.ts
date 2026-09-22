import { ErrorCodes, NarsilError } from '../../errors'
import type { BatchResult } from '../../types/results'
import type { AnyDocument, WriteOptions } from '../../types/schema'
import { BATCH_CHUNK_SIZE } from '../constants'
import { validateDocId } from '../validation'
import { removeDocumentVectors } from '../vector-coordinator'
import type { MutationContext } from './context'
import { rollbackRemovedDocument } from './durable-rollback'
import { recordChunk } from './record-batch'
import { awaitWriteVisibility } from './write-visibility'

interface PreparedRemoval {
  docId: string
  document: null
  restoreDoc: AnyDocument | undefined
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

  const restoreRef = ctx.durability && !rebalancing ? ctx.requireManager(indexName).getRef(docId) : undefined
  return {
    docId,
    document: null,
    restoreDoc: restoreRef ? (structuredClone(restoreRef) as AnyDocument) : undefined,
    buffered: false,
  }
}

function applyOfRemoval(ctx: MutationContext, indexName: string, prepared: PreparedRemoval): () => Promise<void> {
  const { docId } = prepared
  return async (): Promise<void> => {
    if (ctx.isRebalancing(indexName)) {
      const bufferedState = ctx.bufferedDocState(indexName, docId)
      const exists =
        bufferedState !== undefined ? bufferedState === 'present' : ctx.requireManager(indexName).has(docId)
      if (!exists) {
        throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document "${docId}" not found in any partition`, { docId })
      }
    }
    if (ctx.bufferIfRebalancing(indexName, { action: 'remove', docId, indexName })) {
      prepared.buffered = true
      return
    }
    await ctx.executor.execute({ type: 'remove', indexName, docId, requestId: docId })
    removeDocumentVectors(docId, ctx.requireManager(indexName).getVectorIndexes())
  }
}

async function settleRemoval(ctx: MutationContext, indexName: string, docId: string): Promise<void> {
  try {
    await ctx.pluginRegistry.runHook('afterRemove', { indexName, docId })
  } catch (err) {
    console.warn('afterRemove plugin hook error:', err instanceof Error ? err.message : String(err))
  }

  await ctx.orchestrator.replicateToWorkers({
    type: 'remove',
    indexName,
    docId,
    requestId: `replicate-remove-${docId}`,
  })
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
      await rollbackRemovedDocument(ctx, indexName, docId, prepared.restoreDoc, err)
      throw err
    }
  } else {
    await apply()
  }

  if (!prepared.buffered) await settleRemoval(ctx, indexName, docId)
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

  const succeeded: string[] = []
  const failed: BatchResult['failed'] = []
  const manager = ctx.requireManager(indexName)
  manager.beginBatchRemove()

  try {
    for (let chunkStart = 0; chunkStart < docIds.length; chunkStart += BATCH_CHUNK_SIZE) {
      const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, docIds.length)
      const prepared: PreparedRemoval[] = []
      for (let i = chunkStart; i < chunkEnd; i++) {
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
            await rollbackRemovedDocument(ctx, indexName, removal.docId, removal.restoreDoc, error)
          } catch (rollbackError) {
            error = rollbackError
          }
          failed.push({ docId: removal.docId, error: asRemoveError(error) })
          continue
        }
        if (!removal.buffered) await settleRemoval(ctx, indexName, removal.docId)
        succeeded.push(removal.docId)
      }

      if (chunkEnd < docIds.length) {
        await new Promise<void>(r => setTimeout(r, 0))
      }
    }
  } finally {
    manager.endBatchRemove()
  }
  ctx.checkHeapPressure(indexName)
  if (options?.wait === true) await awaitWriteVisibility(ctx, indexName)

  return { succeeded, failed }
}
