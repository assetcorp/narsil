import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError, type NarsilErrorCode } from '../../../errors'
import type { BatchResult } from '../../../types/results'
import type { AnyDocument, InsertOptions } from '../../../types/schema'
import type { PartitionAssignment } from '../../coordinator/types'
import type { ReplicationLogEntry } from '../../replication/types'
import type { ForwardPayload } from '../../transport/types'
import { requireWritableIndex } from '../memory/write-block'
import { estimateForwardedBytes, withAdmittedWrite } from '../memory/write-pressure'
import { assertSufficientActiveReplicas, resolvePrimaryAssignment } from './assignment'
import { rollbackPrimaryInsert, rollbackPrimaryRemove, rollbackPrimaryUpdate } from './failures'
import { inLeadingPartitionQueue } from './leading-queue'
import { appendDeletion, appendStoredCopy, numberedWrite, type PrimaryWriteScope } from './numbered-write'
import { applyInProjectedGroups, projectOne } from './projected-groups'
import { chunkReplicationEntries, replicateEntry, replicateEntryBatch } from './replication'
import type { WriteRoutingDeps } from './types'

export async function applyPrimaryInsert(
  indexName: string,
  document: AnyDocument,
  docId: string,
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
  options?: InsertOptions,
): Promise<string> {
  assertSufficientActiveReplicas(indexName, partitionId, assignment, deps)
  const queued: PrimaryWriteScope = { indexName, partitionId, assignment, deps }
  return inLeadingPartitionQueue(queued, async scope => {
    const projected = projectOne(deps, indexName, document)
    try {
      const inserted = await numberedWrite(
        scope,
        () => deps.engine.insert(indexName, document, docId, options),
        (insertedDocId, admitted) => appendStoredCopy(scope, insertedDocId, admitted),
      )
      try {
        await replicateEntry(inserted.entry, scope.assignment, deps)
      } catch (error) {
        await rollbackPrimaryInsert(scope, inserted.value, error)
      }
      return inserted.value
    } finally {
      projected.release()
    }
  })
}

export async function applyPrimaryRemove(
  indexName: string,
  docId: string,
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
): Promise<void> {
  assertSufficientActiveReplicas(indexName, partitionId, assignment, deps)
  const queued: PrimaryWriteScope = { indexName, partitionId, assignment, deps }
  await inLeadingPartitionQueue(queued, async scope => {
    const previousDocument = await deps.engine.get(indexName, docId)
    const removed = await numberedWrite(
      scope,
      () => deps.engine.remove(indexName, docId),
      () => appendDeletion(scope, docId),
    )
    try {
      await replicateEntry(removed.entry, scope.assignment, deps)
    } catch (error) {
      await rollbackPrimaryRemove(scope, docId, previousDocument, error)
    }
  })
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
  const queued: PrimaryWriteScope = { indexName, partitionId, assignment, deps }
  await inLeadingPartitionQueue(queued, async scope => {
    const projected = projectOne(deps, indexName, document)
    try {
      const previousDocument = await deps.engine.get(indexName, docId)
      const updated = await numberedWrite(
        scope,
        () => deps.engine.update(indexName, docId, document),
        (_, admitted) => appendStoredCopy(scope, docId, admitted),
      )
      try {
        await replicateEntry(updated.entry, scope.assignment, deps)
      } catch (error) {
        await rollbackPrimaryUpdate(scope, docId, previousDocument, error)
      }
    } finally {
      projected.release()
    }
  })
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
  options?: InsertOptions,
): Promise<BatchResult> {
  assertSufficientActiveReplicas(indexName, partitionId, assignment, deps)
  const queued: PrimaryWriteScope = { indexName, partitionId, assignment, deps }
  const failed: BatchResult['failed'] = []
  const succeeded = await inLeadingPartitionQueue(
    queued,
    async scope => {
      const appended: AppendedWrite[] = []
      await applyInProjectedGroups(deps, indexName, {
        items,
        documentOf: item => item.doc,
        docIdOf: item => item.docId,
        failed,
        apply: async item => {
          try {
            const inserted = await numberedWrite(
              scope,
              () => deps.engine.insert(indexName, item.doc, item.docId, options),
              (insertedDocId, admitted) => appendStoredCopy(scope, insertedDocId, admitted),
            )
            appended.push({ docId: inserted.value, entry: inserted.entry })
          } catch (err) {
            failed.push({ docId: item.docId, error: asWriteError(err, ErrorCodes.DOC_VALIDATION_FAILED, item.docId) })
          }
        },
      })
      return replicateAppendedWrites(
        scope.assignment,
        appended,
        failed,
        (write, error) => rollbackPrimaryInsert(scope, write.docId, error),
        deps,
      )
    },
    failed,
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
  const queued: PrimaryWriteScope = { indexName, partitionId, assignment, deps }
  const failed: BatchResult['failed'] = []
  const succeeded = await inLeadingPartitionQueue(
    queued,
    async scope => {
      const appended: AppendedWrite[] = []
      await applyInProjectedGroups(deps, indexName, {
        items: updates,
        documentOf: update => update.document,
        docIdOf: update => update.docId,
        failed,
        apply: async update => {
          try {
            const previousDocument = await deps.engine.get(indexName, update.docId)
            const updated = await numberedWrite(
              scope,
              () => deps.engine.update(indexName, update.docId, update.document),
              (_, admitted) => appendStoredCopy(scope, update.docId, admitted),
            )
            appended.push({ docId: update.docId, entry: updated.entry, previousDocument })
          } catch (err) {
            failed.push({
              docId: update.docId,
              error: asWriteError(err, ErrorCodes.DOC_VALIDATION_FAILED, update.docId),
            })
          }
        },
      })
      return replicateAppendedWrites(
        scope.assignment,
        appended,
        failed,
        (write, error) => rollbackPrimaryUpdate(scope, write.docId, write.previousDocument, error),
        deps,
      )
    },
    failed,
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
  const queued: PrimaryWriteScope = { indexName, partitionId, assignment, deps }
  const failed: BatchResult['failed'] = []
  const succeeded = await inLeadingPartitionQueue(
    queued,
    async scope => {
      const appended: AppendedWrite[] = []
      for (const docId of docIds) {
        try {
          const previousDocument = await deps.engine.get(indexName, docId)
          const removed = await numberedWrite(
            scope,
            () => deps.engine.remove(indexName, docId),
            () => appendDeletion(scope, docId),
          )
          appended.push({ docId, entry: removed.entry, previousDocument })
        } catch (err) {
          failed.push({ docId, error: asWriteError(err, ErrorCodes.QUERY_ROUTING_FAILED, docId) })
        }
      }
      return replicateAppendedWrites(
        scope.assignment,
        appended,
        failed,
        (write, error) => rollbackPrimaryRemove(scope, write.docId, write.previousDocument, error),
        deps,
      )
    },
    failed,
  )
  return { succeeded, failed }
}

async function replicateAppendedWrites(
  assignment: PartitionAssignment,
  appended: AppendedWrite[],
  failed: BatchResult['failed'],
  rollback: (write: AppendedWrite, error: unknown) => Promise<never>,
  deps: WriteRoutingDeps,
): Promise<string[]> {
  const succeeded: string[] = []
  const chunks = chunkReplicationEntries(appended)
  const abandoned: AppendedWrite[] = []
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

    abandoned.push(...chunk)
  }

  for (let index = abandoned.length - 1; index >= 0; index--) {
    const item = abandoned[index]
    try {
      await rollback(item, abortError)
    } catch (err) {
      failed.push({ docId: item.docId, error: asWriteError(err, ErrorCodes.DOC_VALIDATION_FAILED, item.docId) })
    }
  }

  return succeeded
}

export function applyForwardedWrite(payload: ForwardPayload, deps: WriteRoutingDeps): Promise<string> {
  if (payload.operation === 'remove') {
    return applyAdmittedForwardedWrite(payload, deps)
  }
  return withAdmittedWrite(
    deps.writePressure,
    payload.indexName,
    () => estimateForwardedBytes(payload),
    () => applyAdmittedForwardedWrite(payload, deps),
  )
}

async function applyAdmittedForwardedWrite(payload: ForwardPayload, deps: WriteRoutingDeps): Promise<string> {
  const resolution = await resolvePrimaryAssignment(payload.indexName, payload.documentId, deps, true)
  if (resolution === null) {
    throw new NarsilError(
      ErrorCodes.QUERY_ROUTING_FAILED,
      `No allocation table is available for forwarded write to index '${payload.indexName}'`,
      { indexName: payload.indexName },
    )
  }
  if (payload.operation !== 'remove') {
    requireWritableIndex(resolution.table, deps.memoryView)
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
