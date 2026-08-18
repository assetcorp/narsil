import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError, type NarsilErrorCode } from '../../../errors'
import type { BatchResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import type { PartitionAssignment } from '../../coordinator/types'
import type { ReplicationLogEntry } from '../../replication/types'
import type { ForwardPayload } from '../../transport/types'
import { assertSufficientActiveReplicas, resolvePrimaryAssignment } from './assignment'
import { rollbackPrimaryInsert, rollbackPrimaryRemove, rollbackPrimaryUpdate } from './failures'
import { enqueuePartitionWrite } from './partition-queue'
import {
  appendDeleteReplicationEntry,
  appendIndexReplicationEntry,
  chunkReplicationEntries,
  replicateEntry,
  replicateEntryBatch,
} from './replication'
import type { WriteRoutingDeps } from './types'

export async function applyPrimaryInsert(
  indexName: string,
  document: AnyDocument,
  docId: string,
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
): Promise<string> {
  assertSufficientActiveReplicas(indexName, partitionId, assignment, deps)
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
    await enqueuePartitionWrite(deps.partitionWriteQueues, indexName, partitionId, async () => {
      const entry = appendIndexReplicationEntry(indexName, partitionId, assignment, insertedDocId, storedDocument, deps)
      await replicateEntry(entry, assignment, deps)
    })
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
  assertSufficientActiveReplicas(indexName, partitionId, assignment, deps)
  const previousDocument = await deps.engine.get(indexName, docId)
  await deps.engine.remove(indexName, docId)
  try {
    await enqueuePartitionWrite(deps.partitionWriteQueues, indexName, partitionId, async () => {
      const entry = appendDeleteReplicationEntry(indexName, partitionId, assignment, docId, deps)
      await replicateEntry(entry, assignment, deps)
    })
  } catch (error) {
    await rollbackPrimaryRemove(indexName, partitionId, docId, previousDocument, error, deps)
  }
}

export async function applyPrimaryUpdate(
  indexName: string,
  docId: string,
  document: AnyDocument,
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
): Promise<void> {
  assertSufficientActiveReplicas(indexName, partitionId, assignment, deps)
  const previousDocument = await deps.engine.get(indexName, docId)
  await deps.engine.update(indexName, docId, document)
  const storedDocument = await deps.engine.get(indexName, docId)

  if (storedDocument === undefined) {
    throw new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `Updated document '${docId}' could not be read back for replication`,
      { indexName, documentId: docId, partitionId },
    )
  }

  try {
    await enqueuePartitionWrite(deps.partitionWriteQueues, indexName, partitionId, async () => {
      const entry = appendIndexReplicationEntry(indexName, partitionId, assignment, docId, storedDocument, deps)
      await replicateEntry(entry, assignment, deps)
    })
  } catch (error) {
    await rollbackPrimaryUpdate(indexName, partitionId, docId, previousDocument, error, deps)
  }
}

interface AppendedWrite {
  docId: string
  entry: ReplicationLogEntry
  previousDocument?: AnyDocument
}

function asWriteError(err: unknown, fallbackCode: NarsilErrorCode, docId: string): NarsilError {
  return err instanceof NarsilError ? err : new NarsilError(fallbackCode, String(err), { docId })
}

export async function applyPrimaryInsertBatch(
  indexName: string,
  items: Array<{ doc: AnyDocument; docId: string }>,
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
): Promise<BatchResult> {
  assertSufficientActiveReplicas(indexName, partitionId, assignment, deps)
  const failed: BatchResult['failed'] = []
  const prepared: Array<{ docId: string; document: AnyDocument }> = []

  for (const item of items) {
    try {
      const insertedDocId = await deps.engine.insert(indexName, item.doc, item.docId)
      const storedDocument = await deps.engine.get(indexName, insertedDocId)
      if (storedDocument === undefined) {
        throw new NarsilError(
          ErrorCodes.REPLICATION_ENTRY_INVALID,
          `Inserted document '${insertedDocId}' could not be read back for replication`,
          { indexName, documentId: insertedDocId, partitionId },
        )
      }
      prepared.push({ docId: insertedDocId, document: storedDocument })
    } catch (err) {
      failed.push({ docId: item.docId, error: asWriteError(err, ErrorCodes.DOC_VALIDATION_FAILED, item.docId) })
    }
  }

  const succeeded = await enqueuePartitionWrite(deps.partitionWriteQueues, indexName, partitionId, () =>
    replicateAppendedWrites(
      assignment,
      prepared.map(item => ({
        docId: item.docId,
        entry: appendIndexReplicationEntry(indexName, partitionId, assignment, item.docId, item.document, deps),
      })),
      failed,
      (docId, error) => rollbackPrimaryInsert(indexName, partitionId, docId, error, deps),
      deps,
    ),
  )

  return { succeeded, failed }
}

export async function applyPrimaryUpdateBatch(
  indexName: string,
  updates: Array<{ docId: string; document: AnyDocument }>,
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
): Promise<BatchResult> {
  assertSufficientActiveReplicas(indexName, partitionId, assignment, deps)
  const failed: BatchResult['failed'] = []
  const prepared: Array<{ docId: string; document: AnyDocument; previousDocument?: AnyDocument }> = []

  for (const update of updates) {
    try {
      const previousDocument = await deps.engine.get(indexName, update.docId)
      await deps.engine.update(indexName, update.docId, update.document)
      const storedDocument = await deps.engine.get(indexName, update.docId)
      if (storedDocument === undefined) {
        throw new NarsilError(
          ErrorCodes.REPLICATION_ENTRY_INVALID,
          `Updated document '${update.docId}' could not be read back for replication`,
          { indexName, documentId: update.docId, partitionId },
        )
      }
      prepared.push({ docId: update.docId, document: storedDocument, previousDocument })
    } catch (err) {
      failed.push({ docId: update.docId, error: asWriteError(err, ErrorCodes.DOC_VALIDATION_FAILED, update.docId) })
    }
  }

  const preparedByDocId = new Map(prepared.map(item => [item.docId, item]))
  const succeeded = await enqueuePartitionWrite(deps.partitionWriteQueues, indexName, partitionId, () =>
    replicateAppendedWrites(
      assignment,
      prepared.map(item => ({
        docId: item.docId,
        entry: appendIndexReplicationEntry(indexName, partitionId, assignment, item.docId, item.document, deps),
      })),
      failed,
      (docId, error) =>
        rollbackPrimaryUpdate(indexName, partitionId, docId, preparedByDocId.get(docId)?.previousDocument, error, deps),
      deps,
    ),
  )

  return { succeeded, failed }
}

export async function applyPrimaryRemoveBatch(
  indexName: string,
  docIds: string[],
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
): Promise<BatchResult> {
  assertSufficientActiveReplicas(indexName, partitionId, assignment, deps)
  const failed: BatchResult['failed'] = []
  const prepared: Array<{ docId: string; previousDocument?: AnyDocument }> = []

  for (const docId of docIds) {
    try {
      const previousDocument = await deps.engine.get(indexName, docId)
      await deps.engine.remove(indexName, docId)
      prepared.push({ docId, previousDocument })
    } catch (err) {
      failed.push({ docId, error: asWriteError(err, ErrorCodes.QUERY_ROUTING_FAILED, docId) })
    }
  }

  const preparedByDocId = new Map(prepared.map(item => [item.docId, item]))
  const succeeded = await enqueuePartitionWrite(deps.partitionWriteQueues, indexName, partitionId, () =>
    replicateAppendedWrites(
      assignment,
      prepared.map(item => ({
        docId: item.docId,
        entry: appendDeleteReplicationEntry(indexName, partitionId, assignment, item.docId, deps),
      })),
      failed,
      (docId, error) =>
        rollbackPrimaryRemove(indexName, partitionId, docId, preparedByDocId.get(docId)?.previousDocument, error, deps),
      deps,
    ),
  )

  return { succeeded, failed }
}

async function replicateAppendedWrites(
  assignment: PartitionAssignment,
  appended: AppendedWrite[],
  failed: BatchResult['failed'],
  rollback: (docId: string, error: unknown) => Promise<never>,
  deps: WriteRoutingDeps,
): Promise<string[]> {
  const succeeded: string[] = []
  const chunks = chunkReplicationEntries(appended)
  let abortError: unknown

  for (const chunk of chunks) {
    if (abortError === undefined) {
      try {
        await replicateEntryBatch(
          chunk.map(item => item.entry),
          assignment,
          deps,
        )
        succeeded.push(...chunk.map(item => item.docId))
        continue
      } catch (error) {
        abortError = error
      }
    }

    for (const item of chunk) {
      try {
        await rollback(item.docId, abortError)
      } catch (err) {
        failed.push({ docId: item.docId, error: asWriteError(err, ErrorCodes.DOC_VALIDATION_FAILED, item.docId) })
      }
    }
  }

  return succeeded
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

  const replacement = await resolveForwardedUpdateDocument(
    payload.indexName,
    payload.documentId,
    payload.document,
    payload.updateFields,
    deps,
  )
  await applyPrimaryUpdate(
    payload.indexName,
    payload.documentId,
    replacement,
    resolution.partitionId,
    resolution.assignment,
    deps,
  )
  return payload.documentId
}

export async function resolveForwardedUpdateDocument(
  indexName: string,
  documentId: string,
  document: Uint8Array | null,
  updateFields: Record<string, unknown> | null,
  deps: WriteRoutingDeps,
): Promise<AnyDocument> {
  if (document !== null) {
    return decode(document) as AnyDocument
  }
  if (updateFields === null) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Invalid ForwardPayload: update requires a document or updateFields',
    )
  }
  const existing = await deps.engine.get(indexName, documentId)
  if (existing === undefined) {
    throw new NarsilError(ErrorCodes.DOC_NOT_FOUND, `Document '${documentId}' does not exist in index '${indexName}'`, {
      indexName,
      documentId,
    })
  }
  return { ...existing, ...updateFields }
}
