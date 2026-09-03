import { describeError, ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import type { PartitionAssignment } from '../../coordinator/types'
import { appendDeleteReplicationEntry, appendIndexReplicationEntry } from './replication'
import type { WriteRoutingDeps } from './types'

/**
 * The partition one primary write belongs to, which every rollback needs to
 * restore the document and to compensate the entry it already appended.
 *
 * @internal
 */
export interface PrimaryWriteScope {
  indexName: string
  partitionId: number
  assignment: PartitionAssignment
  deps: WriteRoutingDeps
}

export function throwWriteFailure(error: unknown): never {
  if (error instanceof Error) {
    throw error
  }
  throw new Error(String(error))
}

export function createRollbackFailure(
  operation: 'insert' | 'remove' | 'update',
  scope: PrimaryWriteScope,
  documentId: string,
  originalError: unknown,
  rollbackError: unknown,
): NarsilError {
  return new NarsilError(
    ErrorCodes.REPLICATION_ROLLBACK_FAILED,
    `Primary ${operation} for document '${documentId}' in index '${scope.indexName}' failed before acknowledgement and local rollback also failed`,
    {
      operation,
      indexName: scope.indexName,
      partitionId: scope.partitionId,
      documentId,
      originalError: describeError(originalError),
      rollbackError: describeError(rollbackError),
    },
  )
}

function lostPrimaryAuthority(originalError: unknown): boolean {
  return originalError instanceof NarsilError && originalError.code === ErrorCodes.PARTITION_NOT_PRIMARY
}

function compensate(
  operation: 'insert' | 'remove' | 'update',
  scope: PrimaryWriteScope,
  documentId: string,
  restored: AnyDocument | undefined,
  originalError: unknown,
): void {
  if (lostPrimaryAuthority(originalError)) {
    return
  }

  try {
    if (restored === undefined) {
      appendDeleteReplicationEntry(scope.indexName, scope.partitionId, scope.assignment, documentId, scope.deps)
      return
    }
    appendIndexReplicationEntry(scope.indexName, scope.partitionId, scope.assignment, documentId, restored, scope.deps)
  } catch (appendError) {
    throw createRollbackFailure(operation, scope, documentId, originalError, appendError)
  }
}

export async function rollbackPrimaryInsert(
  scope: PrimaryWriteScope,
  documentId: string,
  originalError: unknown,
): Promise<never> {
  try {
    await scope.deps.engine.remove(scope.indexName, documentId)
  } catch (rollbackError) {
    if (!(rollbackError instanceof NarsilError && rollbackError.code === ErrorCodes.DOC_NOT_FOUND)) {
      throw createRollbackFailure('insert', scope, documentId, originalError, rollbackError)
    }
  }

  compensate('insert', scope, documentId, undefined, originalError)
  throwWriteFailure(originalError)
}

export async function rollbackPrimaryUpdate(
  scope: PrimaryWriteScope,
  documentId: string,
  previousDocument: AnyDocument | undefined,
  originalError: unknown,
): Promise<never> {
  if (previousDocument === undefined) {
    throw createRollbackFailure(
      'update',
      scope,
      documentId,
      originalError,
      new Error('No local document snapshot was available for restore'),
    )
  }

  try {
    await scope.deps.engine.update(scope.indexName, documentId, previousDocument)
  } catch (rollbackError) {
    throw createRollbackFailure('update', scope, documentId, originalError, rollbackError)
  }

  compensate('update', scope, documentId, previousDocument, originalError)
  throwWriteFailure(originalError)
}

export async function rollbackPrimaryRemove(
  scope: PrimaryWriteScope,
  documentId: string,
  previousDocument: AnyDocument | undefined,
  originalError: unknown,
): Promise<never> {
  if (previousDocument === undefined) {
    throw createRollbackFailure(
      'remove',
      scope,
      documentId,
      originalError,
      new Error('No local document snapshot was available for restore'),
    )
  }

  try {
    await scope.deps.engine.insert(scope.indexName, previousDocument, documentId)
  } catch (rollbackError) {
    throw createRollbackFailure('remove', scope, documentId, originalError, rollbackError)
  }

  compensate('remove', scope, documentId, previousDocument, originalError)
  throwWriteFailure(originalError)
}
