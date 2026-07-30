import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import type { WriteRoutingDeps } from './types'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function throwWriteFailure(error: unknown): never {
  if (error instanceof Error) {
    throw error
  }
  throw new Error(String(error))
}

export function createRollbackFailure(
  operation: 'insert' | 'remove',
  indexName: string,
  partitionId: number,
  documentId: string,
  originalError: unknown,
  rollbackError: unknown,
): NarsilError {
  return new NarsilError(
    ErrorCodes.REPLICATION_ROLLBACK_FAILED,
    `Primary ${operation} for document '${documentId}' in index '${indexName}' failed before acknowledgement and local rollback also failed`,
    {
      operation,
      indexName,
      partitionId,
      documentId,
      originalError: errorMessage(originalError),
      rollbackError: errorMessage(rollbackError),
    },
  )
}

export async function rollbackPrimaryInsert(
  indexName: string,
  partitionId: number,
  documentId: string,
  originalError: unknown,
  deps: WriteRoutingDeps,
): Promise<never> {
  try {
    await deps.engine.remove(indexName, documentId)
  } catch (rollbackError) {
    if (!(rollbackError instanceof NarsilError && rollbackError.code === ErrorCodes.DOC_NOT_FOUND)) {
      throw createRollbackFailure('insert', indexName, partitionId, documentId, originalError, rollbackError)
    }
  }

  throwWriteFailure(originalError)
}

export async function rollbackPrimaryRemove(
  indexName: string,
  partitionId: number,
  documentId: string,
  previousDocument: AnyDocument | undefined,
  originalError: unknown,
  deps: WriteRoutingDeps,
): Promise<never> {
  if (previousDocument === undefined) {
    throw createRollbackFailure(
      'remove',
      indexName,
      partitionId,
      documentId,
      originalError,
      new Error('No local document snapshot was available for restore'),
    )
  }

  try {
    await deps.engine.insert(indexName, previousDocument, documentId)
  } catch (rollbackError) {
    throw createRollbackFailure('remove', indexName, partitionId, documentId, originalError, rollbackError)
  }

  throwWriteFailure(originalError)
}
