import { describeError, ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import type { ReplicationLogEntry } from '../../replication/types'
import { appendDeletion, appendStoredCopy, copyFailedIn, numberedWrite, type PrimaryWriteScope } from './numbered-write'
import { failedCopyOutcome } from './rollback'

export type { PrimaryWriteScope }

export function throwWriteFailure(error: unknown): never {
  if (error instanceof Error) {
    throw error
  }
  throw new Error(String(error))
}

type WrittenOperation = 'insert' | 'remove' | 'update'

function rollbackRefusal(
  operation: WrittenOperation,
  scope: PrimaryWriteScope,
  documentId: string,
  originalError: unknown,
  rollbackError: unknown,
): NarsilError {
  const failure = createRollbackFailure(operation, scope, documentId, originalError, rollbackError)
  const { failCopy } = scope.deps
  if (failCopy === undefined && !copyFailedIn(scope)) return failure
  failCopy?.(scope.indexName, scope.partitionId, failure)
  return failedCopyOutcome(scope, failure)
}

function createRollbackFailure(
  operation: WrittenOperation,
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

export async function compensateInsert(
  scope: PrimaryWriteScope,
  documentId: string,
  originalError: unknown,
): Promise<ReplicationLogEntry | undefined> {
  try {
    const removed = await numberedWrite(
      scope,
      () => scope.deps.engine.remove(scope.indexName, documentId),
      () => appendDeletion(scope, documentId),
    )
    return removed.entry
  } catch (rollbackError) {
    if (!(rollbackError instanceof NarsilError && rollbackError.code === ErrorCodes.DOC_NOT_FOUND)) {
      throw rollbackRefusal('insert', scope, documentId, originalError, rollbackError)
    }
    return undefined
  }
}

export async function compensateUpdate(
  scope: PrimaryWriteScope,
  documentId: string,
  previousDocument: AnyDocument | undefined,
  originalError: unknown,
): Promise<ReplicationLogEntry> {
  if (previousDocument === undefined) {
    throw rollbackRefusal(
      'update',
      scope,
      documentId,
      originalError,
      new Error('No local document snapshot was available for restore'),
    )
  }

  try {
    const restored = await numberedWrite(
      scope,
      () => scope.deps.engine.update(scope.indexName, documentId, previousDocument),
      (_, admitted) => appendStoredCopy(scope, documentId, admitted),
    )
    return restored.entry
  } catch (rollbackError) {
    throw rollbackRefusal('update', scope, documentId, originalError, rollbackError)
  }
}

export async function compensateRemove(
  scope: PrimaryWriteScope,
  documentId: string,
  previousDocument: AnyDocument | undefined,
  originalError: unknown,
): Promise<ReplicationLogEntry> {
  if (previousDocument === undefined) {
    throw rollbackRefusal(
      'remove',
      scope,
      documentId,
      originalError,
      new Error('No local document snapshot was available for restore'),
    )
  }

  try {
    const restored = await numberedWrite(
      scope,
      () => scope.deps.engine.insert(scope.indexName, previousDocument, documentId),
      (_, admitted) => appendStoredCopy(scope, documentId, admitted),
    )
    return restored.entry
  } catch (rollbackError) {
    throw rollbackRefusal('remove', scope, documentId, originalError, rollbackError)
  }
}
