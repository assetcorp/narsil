import { ErrorCodes, NarsilError } from '../../errors'
import type { BatchResult } from '../../types/results'
import { BATCH_CHUNK_SIZE, validateDocId } from '../validation'
import { removeDocumentVectors } from '../vector-coordinator'
import type { MutationContext } from './context'

export async function removeDocument(ctx: MutationContext, indexName: string, docId: string): Promise<void> {
  ctx.guardShutdown()
  ctx.requireIndex(indexName)
  validateDocId(docId)

  if (ctx.bufferIfRebalancing(indexName, { action: 'remove', docId, indexName })) {
    return
  }

  await ctx.pluginRegistry.runHook('beforeRemove', { indexName, docId })

  await ctx.executor.execute({ type: 'remove', indexName, docId, requestId: docId })

  const removeManager = ctx.requireManager(indexName)
  const removeVecIndexes = removeManager.getVectorIndexes()
  removeDocumentVectors(docId, removeVecIndexes)

  try {
    await ctx.pluginRegistry.runHook('afterRemove', { indexName, docId })
  } catch (err) {
    console.warn('afterRemove plugin hook error:', err instanceof Error ? err.message : String(err))
  }

  ctx.flushManager?.markDirty(indexName, 0)

  await ctx.orchestrator.replicateToWorkers({
    type: 'remove',
    indexName,
    docId,
    requestId: `replicate-remove-${docId}`,
  })
}

export async function removeDocumentBatch(
  ctx: MutationContext,
  indexName: string,
  docIds: string[],
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

      for (let i = chunkStart; i < chunkEnd; i++) {
        try {
          await removeDocument(ctx, indexName, docIds[i])
          succeeded.push(docIds[i])
        } catch (err) {
          failed.push({
            docId: docIds[i],
            error: err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_NOT_FOUND, String(err)),
          })
        }
      }

      if (chunkEnd < docIds.length) {
        await new Promise<void>(r => setTimeout(r, 0))
      }
    }
  } finally {
    manager.endBatchRemove()
  }

  return { succeeded, failed }
}
