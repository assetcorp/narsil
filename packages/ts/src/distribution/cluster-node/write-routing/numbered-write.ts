import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import type { PartitionAssignment } from '../../coordinator/types'
import type { ReplicationLogEntry } from '../../replication/types'
import { appendDeleteReplicationEntry, appendIndexReplicationEntry } from './replication'
import type { WriteRoutingDeps } from './types'

export interface PrimaryWriteScope {
  indexName: string
  partitionId: number
  assignment: PartitionAssignment
  deps: WriteRoutingDeps
}

export interface NumberedWrite<T> {
  value: T
  entry: ReplicationLogEntry
}

export async function numberedWrite<T>(
  scope: PrimaryWriteScope,
  write: () => Promise<T>,
  appendOutsideTheLog: (value: T) => Promise<ReplicationLogEntry>,
): Promise<NumberedWrite<T>> {
  const writes = scope.deps.numbering?.open(
    scope.indexName,
    scope.partitionId,
    () => scope.deps.getReplicationLog(scope.indexName, scope.partitionId),
    scope.assignment.primaryTerm,
  )
  let value: T
  try {
    value = await write()
  } finally {
    writes?.close()
  }
  const recorded = writes?.entries.at(-1)
  return { value, entry: recorded ?? (await appendOutsideTheLog(value)) }
}

export async function storedCopyOf(scope: PrimaryWriteScope, documentId: string): Promise<AnyDocument> {
  const stored = await scope.deps.engine.get(scope.indexName, documentId)
  if (stored === undefined) {
    throw new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `Document '${documentId}' could not be read back for replication`,
      { indexName: scope.indexName, documentId, partitionId: scope.partitionId },
    )
  }
  return stored
}

export async function appendStoredCopy(scope: PrimaryWriteScope, documentId: string): Promise<ReplicationLogEntry> {
  const stored = await storedCopyOf(scope, documentId)
  return appendIndexReplicationEntry(
    scope.indexName,
    scope.partitionId,
    scope.assignment,
    documentId,
    stored,
    scope.deps,
  )
}

export function appendDeletion(scope: PrimaryWriteScope, documentId: string): Promise<ReplicationLogEntry> {
  return Promise.resolve(
    appendDeleteReplicationEntry(scope.indexName, scope.partitionId, scope.assignment, documentId, scope.deps),
  )
}
