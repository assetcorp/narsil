import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument, InsertOptions } from '../../../types/schema'
import type { PartitionAssignment } from '../../coordinator/types'
import type { ForwardPayload, WriteCondition } from '../../transport/types'
import { requireWritableIndex } from '../memory/write-block'
import { estimateForwardedBytes, withAdmittedWrite } from '../memory/write-pressure'
import { markAbandoned, previousRecordOf } from './abandoned-write'
import { assertSufficientActiveReplicas, resolvePrimaryAssignment } from './assignment'
import { type AppendedWrite, asWriteError, createGroupCommit, replicateAppendedWrites } from './batch-commit'
import type { BatchOutcome, BatchWrite, WriteFailure } from './batch-write'
import { compensateInsert, compensateRemove, compensateUpdate, throwWriteFailure } from './failures'
import {
  decodeForwardedDocument,
  type ForwardedReplacement,
  forwardedReplacementOf,
  replacementFor,
  sizeStoredMerges,
} from './forwarded-document'
import { inLeadingPartitionQueue } from './leading-queue'
import {
  appendDeletion,
  appendStoredCopy,
  numberedWrite,
  type PrimaryWriteScope,
  WHOLE_DOCUMENT,
} from './numbered-write'
import { applyInProjectedGroups, projectOne } from './projected-groups'
import { replicateEntry } from './replication'
import { settleRollback } from './rollback'
import type { WriteRoutingDeps } from './types'
import { type AppliedResends, conditionOfFields, decideCondition, noteAppliedResend } from './write-condition'

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
        await replicateEntry(inserted.entry, scope.assignment, deps, scope.indexUuid)
      } catch (error) {
        const failedAt = Date.now()
        await compensateInsert(scope, inserted.value, error)
        throwWriteFailure(await settleRollback(scope, inserted.entry.seqNo, error, failedAt))
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
  condition?: WriteCondition,
): Promise<void> {
  assertSufficientActiveReplicas(indexName, partitionId, assignment, deps)
  const queued: PrimaryWriteScope = { indexName, partitionId, assignment, deps }
  await inLeadingPartitionQueue(queued, async scope => {
    if (condition !== undefined && decideCondition(scope, docId, condition) === 'acknowledge') return
    const previousDocument = await deps.engine.get(indexName, docId, WHOLE_DOCUMENT)
    const previousRecord = previousRecordOf(scope, docId)
    const removed = await numberedWrite(
      scope,
      () => deps.engine.remove(indexName, docId),
      () => appendDeletion(scope, docId),
    )
    try {
      await replicateEntry(removed.entry, scope.assignment, deps, scope.indexUuid)
    } catch (error) {
      const failedAt = Date.now()
      const compensation = await compensateRemove(scope, docId, previousDocument, error)
      const answer = await settleRollback(scope, removed.entry.seqNo, error, failedAt)
      throwWriteFailure(markAbandoned(answer, removed.entry, compensation, previousRecord))
    }
  })
}

export async function applyPrimaryUpdate(
  indexName: string,
  docId: string,
  replacement: ForwardedReplacement,
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
  condition?: WriteCondition,
): Promise<void> {
  assertSufficientActiveReplicas(indexName, partitionId, assignment, deps)
  const queued: PrimaryWriteScope = { indexName, partitionId, assignment, deps }
  await inLeadingPartitionQueue(queued, async scope => {
    if (condition !== undefined && decideCondition(scope, docId, condition) === 'acknowledge') return
    const previousDocument = await deps.engine.get(indexName, docId, WHOLE_DOCUMENT)
    const document = replacementFor(replacement, previousDocument)
    const projected = projectOne(deps, indexName, document)
    try {
      const previousRecord = previousRecordOf(scope, docId)
      const updated = await numberedWrite(
        scope,
        () => deps.engine.update(indexName, docId, document),
        (_, admitted) => appendStoredCopy(scope, docId, admitted),
      )
      try {
        await replicateEntry(updated.entry, scope.assignment, deps, scope.indexUuid)
      } catch (error) {
        const failedAt = Date.now()
        const compensation = await compensateUpdate(scope, docId, previousDocument, error)
        const answer = await settleRollback(scope, updated.entry.seqNo, error, failedAt)
        throwWriteFailure(markAbandoned(answer, updated.entry, compensation, previousRecord))
      }
    } finally {
      projected.release()
    }
  })
}

export async function applyPrimaryInsertBatch(
  indexName: string,
  writes: readonly BatchWrite<AnyDocument>[],
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
  options?: InsertOptions,
): Promise<BatchOutcome<AnyDocument>> {
  assertSufficientActiveReplicas(indexName, partitionId, assignment, deps)
  const queued: PrimaryWriteScope = { indexName, partitionId, assignment, deps }
  const failed: WriteFailure<AnyDocument>[] = []
  const succeeded = await inLeadingPartitionQueue(
    queued,
    async scope => {
      const appended: AppendedWrite<AnyDocument>[] = []
      const groupCommit = createGroupCommit(scope, appended, failed)
      await applyInProjectedGroups(deps, indexName, {
        writes,
        failed,
        afterGroup: groupCommit.afterGroup,
        apply: async write => {
          if (groupCommit.refuse(write)) return
          try {
            const inserted = await numberedWrite(
              scope,
              () => deps.engine.insert(indexName, write.value, write.docId, options),
              (insertedDocId, admitted) => appendStoredCopy(scope, insertedDocId, admitted),
              true,
            )
            appended.push({ write, entry: inserted.entry })
          } catch (err) {
            failed.push({ write, error: asWriteError(err, ErrorCodes.DOC_VALIDATION_FAILED, write.docId) })
          }
        },
      })
      return replicateAppendedWrites(
        scope,
        appended,
        failed,
        ({ write }, error) => compensateInsert(scope, write.docId, error),
        deps,
      )
    },
    failed,
  )
  return { succeeded, failed }
}

export async function applyPrimaryUpdateBatch(
  indexName: string,
  writes: readonly BatchWrite<AnyDocument>[],
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
  resends?: AppliedResends,
): Promise<BatchOutcome<AnyDocument>> {
  assertSufficientActiveReplicas(indexName, partitionId, assignment, deps)
  const queued: PrimaryWriteScope = { indexName, partitionId, assignment, deps }
  const failed: WriteFailure<AnyDocument>[] = []
  const succeeded = await inLeadingPartitionQueue(
    queued,
    async scope => {
      const appended: AppendedWrite<AnyDocument>[] = []
      const acknowledged: BatchWrite<AnyDocument>[] = []
      const groupCommit = createGroupCommit(scope, appended, failed)
      await sizeStoredMerges(deps, indexName, writes)
      await applyInProjectedGroups(deps, indexName, {
        writes,
        failed,
        afterGroup: groupCommit.afterGroup,
        apply: async write => {
          if (groupCommit.refuse(write)) return
          const { docId, condition } = write
          try {
            if (condition !== undefined && decideCondition(scope, docId, condition, resends) === 'acknowledge') {
              acknowledged.push(write)
              return
            }
            const previousDocument = await deps.engine.get(indexName, docId, WHOLE_DOCUMENT)
            const value = write.mergeWithStored?.(previousDocument) ?? write.value
            const previousRecord = previousRecordOf(scope, docId)
            const updated = await numberedWrite(
              scope,
              () => deps.engine.update(indexName, docId, value),
              (_, admitted) => appendStoredCopy(scope, docId, admitted),
              true,
            )
            noteAppliedResend(resends, docId, condition, updated.entry)
            appended.push({ write, entry: updated.entry, previousDocument, previousRecord })
          } catch (err) {
            failed.push({ write, error: asWriteError(err, ErrorCodes.DOC_VALIDATION_FAILED, docId) })
          }
        },
      })
      const replicated = await replicateAppendedWrites(
        scope,
        appended,
        failed,
        ({ write, previousDocument }, error) => compensateUpdate(scope, write.docId, previousDocument, error),
        deps,
      )
      return [...acknowledged, ...replicated]
    },
    failed,
  )
  return { succeeded, failed }
}

export async function applyPrimaryRemoveBatch(
  indexName: string,
  writes: readonly BatchWrite<null>[],
  partitionId: number,
  assignment: PartitionAssignment,
  deps: WriteRoutingDeps,
  resends?: AppliedResends,
): Promise<BatchOutcome<null>> {
  assertSufficientActiveReplicas(indexName, partitionId, assignment, deps)
  const queued: PrimaryWriteScope = { indexName, partitionId, assignment, deps }
  const failed: WriteFailure<null>[] = []
  const succeeded = await inLeadingPartitionQueue(
    queued,
    async scope => {
      const appended: AppendedWrite<null>[] = []
      const acknowledged: BatchWrite<null>[] = []
      const groupCommit = createGroupCommit(scope, appended, failed)
      for (const write of writes) {
        const { docId, condition } = write
        try {
          if (condition !== undefined && decideCondition(scope, docId, condition, resends) === 'acknowledge') {
            acknowledged.push(write)
            continue
          }
          const previousDocument = await deps.engine.get(indexName, docId, WHOLE_DOCUMENT)
          const previousRecord = previousRecordOf(scope, docId)
          const removed = await numberedWrite(
            scope,
            () => deps.engine.remove(indexName, docId),
            () => appendDeletion(scope, docId),
            true,
          )
          noteAppliedResend(resends, docId, condition, removed.entry)
          appended.push({ write, entry: removed.entry, previousDocument, previousRecord })
        } catch (err) {
          failed.push({ write, error: asWriteError(err, ErrorCodes.QUERY_ROUTING_FAILED, docId) })
        }
      }
      await groupCommit.afterGroup()
      const replicated = await replicateAppendedWrites(
        scope,
        appended,
        failed,
        ({ write, previousDocument }, error) => compensateRemove(scope, write.docId, previousDocument, error),
        deps,
      )
      return [...acknowledged, ...replicated]
    },
    failed,
  )
  return { succeeded, failed }
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
  const condition = conditionOfFields(payload, payload.operation, payload.documentId)
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
      throw new NarsilError(ErrorCodes.REPLICATION_ENTRY_INVALID, 'Invalid ForwardPayload: insert requires a document')
    }
    const document = decodeForwardedDocument(deps, payload.indexName, payload.document, payload.documentId)
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
    await applyPrimaryRemove(
      payload.indexName,
      payload.documentId,
      resolution.partitionId,
      resolution.assignment,
      deps,
      condition,
    )
    return payload.documentId
  }

  const replacement = forwardedReplacementOf(
    deps,
    payload.indexName,
    payload.documentId,
    payload.document,
    payload.updateFields,
  )
  await applyPrimaryUpdate(
    payload.indexName,
    payload.documentId,
    replacement,
    resolution.partitionId,
    resolution.assignment,
    deps,
    condition,
  )
  return payload.documentId
}
