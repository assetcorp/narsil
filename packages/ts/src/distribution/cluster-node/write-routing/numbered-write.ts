import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import type { PartitionAssignment } from '../../coordinator/types'
import type { ReplicationLogEntry } from '../../replication/types'
import type { HoldPartitionQueue } from './partition-queue'
import { appendDeleteReplicationEntry, appendIndexReplicationEntry } from './replication'
import type { WriteRoutingDeps } from './types'

export interface PrimaryWriteScope {
  indexName: string
  partitionId: number
  assignment: PartitionAssignment
  deps: WriteRoutingDeps
  indexUuid?: string
  holdQueue?: HoldPartitionQueue
}

export interface NumberedWrite<T> {
  value: T
  entry: ReplicationLogEntry
}

export type AdmittedDocuments = (documentId: string) => Uint8Array | null | undefined

export async function numberedWrite<T>(
  scope: PrimaryWriteScope,
  write: () => Promise<T>,
  appendOutsideTheLog: (value: T, admitted: AdmittedDocuments) => Promise<ReplicationLogEntry>,
  deferCommit = false,
): Promise<NumberedWrite<T>> {
  const writes = scope.deps.numbering?.open(
    scope.indexName,
    scope.partitionId,
    () => scope.deps.getReplicationLog(scope.indexName, scope.partitionId),
    scope.assignment.primaryTerm,
    deferCommit && scope.deps.commitPartitionLog !== undefined,
  )
  let value: T
  try {
    value = await write()
  } finally {
    writes?.close()
  }
  const recorded = writes?.entries.at(-1)
  if (recorded !== undefined) return { value, entry: recorded }
  const admitted: AdmittedDocuments = documentId => writes?.admittedDocument(documentId)
  return { value, entry: await appendOutsideTheLog(value, admitted) }
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

export async function appendStoredCopy(
  scope: PrimaryWriteScope,
  documentId: string,
  admitted: AdmittedDocuments,
): Promise<ReplicationLogEntry> {
  const admittedDocument = admitted(documentId)
  if (admittedDocument instanceof Uint8Array) {
    return scope.deps.getReplicationLog(scope.indexName, scope.partitionId).append({
      primaryTerm: scope.assignment.primaryTerm,
      operation: 'INDEX',
      partitionId: scope.partitionId,
      indexName: scope.indexName,
      documentId,
      document: admittedDocument,
    })
  }
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
