import { ErrorCodes, NarsilError } from '../../errors'
import type { AnyDocument } from '../../types/schema'
import { removeDocumentVectors } from '../vector-coordinator'
import type { MutationContext } from './context'

function rollbackFailed(docId: string, originalError: unknown, rollbackError: unknown): never {
  throw new NarsilError(
    ErrorCodes.REPLICATION_ROLLBACK_FAILED,
    `Durable write failed for document "${docId}" and the in-memory rollback also failed; the partition may expose an unacknowledged mutation`,
    {
      docId,
      originalError: originalError instanceof Error ? originalError.message : String(originalError),
      rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
    },
  )
}

export async function rollbackInsertedDocument(
  ctx: MutationContext,
  indexName: string,
  docId: string,
  inserted: boolean,
  originalError: unknown,
): Promise<void> {
  if (!inserted) {
    return
  }
  try {
    await ctx.executor.execute({ type: 'remove', indexName, docId, requestId: docId })
    removeDocumentVectors(docId, ctx.requireManager(indexName).getVectorIndexes())
  } catch (rollbackError) {
    rollbackFailed(docId, originalError, rollbackError)
  }
}

export async function rollbackRemovedDocument(
  ctx: MutationContext,
  indexName: string,
  docId: string,
  restoreDoc: AnyDocument | undefined,
  originalError: unknown,
): Promise<void> {
  if (restoreDoc === undefined) {
    return
  }
  try {
    await ctx.executor.execute({ type: 'insert', indexName, docId, document: restoreDoc, requestId: docId })
  } catch (rollbackError) {
    rollbackFailed(docId, originalError, rollbackError)
  }
}

export async function rollbackUpdatedDocument(
  ctx: MutationContext,
  indexName: string,
  docId: string,
  restoreDoc: AnyDocument | undefined,
  originalError: unknown,
): Promise<void> {
  if (restoreDoc === undefined) {
    return
  }
  try {
    await ctx.executor.execute({ type: 'update', indexName, docId, document: restoreDoc, requestId: docId })
  } catch (rollbackError) {
    rollbackFailed(docId, originalError, rollbackError)
  }
}
