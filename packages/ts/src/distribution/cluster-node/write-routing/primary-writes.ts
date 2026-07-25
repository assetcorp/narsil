import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import type { PartitionAssignment } from '../../coordinator/types'
import type { ForwardPayload } from '../../transport/types'
import { resolvePrimaryAssignment } from './assignment'
import { rollbackPrimaryInsert, rollbackPrimaryRemove } from './failures'
import { appendDeleteReplicationEntry, appendIndexReplicationEntry, replicateEntry } from './replication'
import type { WriteRoutingDeps } from './types'

export async function applyPrimaryInsert(
  indexName: string,
  document: AnyDocument,
  docId: string,
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
): Promise<string> {
  const insertedDocId = await deps.engine.insert(indexName, document, docId)
  const storedDocument = await deps.engine.get(indexName, insertedDocId)

  if (storedDocument === undefined) {
    throw new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `Inserted document '${insertedDocId}' could not be read back for replication`,
      { indexName, documentId: insertedDocId, partitionId },
    )
  }

  try {
    const entry = appendIndexReplicationEntry(indexName, partitionId, assignment, insertedDocId, storedDocument, deps)
    await replicateEntry(entry, assignment, deps)
  } catch (error) {
    await rollbackPrimaryInsert(indexName, partitionId, insertedDocId, error, deps)
  }

  return insertedDocId
}

export async function applyPrimaryRemove(
  indexName: string,
  docId: string,
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
): Promise<void> {
  const previousDocument = await deps.engine.get(indexName, docId)
  await deps.engine.remove(indexName, docId)
  try {
    const entry = appendDeleteReplicationEntry(indexName, partitionId, assignment, docId, deps)
    await replicateEntry(entry, assignment, deps)
  } catch (error) {
    await rollbackPrimaryRemove(indexName, partitionId, docId, previousDocument, error, deps)
  }
}

export async function applyForwardedWrite(payload: ForwardPayload, deps: WriteRoutingDeps): Promise<string> {
  const resolution = await resolvePrimaryAssignment(payload.indexName, payload.documentId, deps, true)
  if (resolution === null) {
    throw new NarsilError(
      ErrorCodes.QUERY_ROUTING_FAILED,
      `No allocation table is available for forwarded write to index '${payload.indexName}'`,
      { indexName: payload.indexName },
    )
  }

  if (payload.operation === 'insert') {
    if (payload.document === null) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: insert requires a document')
    }
    const document = decode(payload.document) as AnyDocument
    return applyPrimaryInsert(
      payload.indexName,
      document,
      payload.documentId,
      resolution.partitionId,
      resolution.assignment,
      deps,
    )
  }

  if (payload.operation === 'remove') {
    await applyPrimaryRemove(payload.indexName, payload.documentId, resolution.partitionId, resolution.assignment, deps)
    return payload.documentId
  }

  throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Forward update operations are not supported yet')
}
