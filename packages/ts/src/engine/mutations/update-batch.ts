import {
  awaitWriteVisibility,
  BATCH_CHUNK_SIZE,
  ErrorCodes,
  NarsilError,
  turnIsSpent,
  turnsAreBudgeted,
  validateBatchList,
  yieldTurn,
} from '#platform/optional-writes-host'
import type { BatchResult } from '../../types/results'
import type { AnyDocument, WriteOptions } from '../../types/schema'
import type { IndexHold } from '../index-hold'
import {
  applyUnlessShutDown,
  batchStopped,
  failAsShutDown,
  shutDownError,
  stoppedByShutdown,
  unlessShutDown,
} from './batch-shutdown'
import type { MutationContext } from './context'
import { rollbackUpdatedDocument } from './durable-rollback'
import { type ChunkFailure, recordChunk } from './record-batch'
import {
  applyOfUpdate,
  asUpdateError,
  finishUpdate,
  type PreparedUpdate,
  settleUpdates,
  updatePreparationOf,
} from './update'
import { type PreparedWrites, prepareDocumentWrites, type WritePreparation } from './write-preparation'

function reportedDocIdOf(update: unknown): string {
  const docId = update !== null && typeof update === 'object' ? (update as { docId?: unknown }).docId : undefined
  return typeof docId === 'string' ? docId : ''
}

function requireUpdateEntry(update: unknown): { document: AnyDocument } {
  if (update !== null && typeof update === 'object' && !Array.isArray(update)) {
    const { docId, document } = update as { docId?: unknown; document?: unknown }
    if (typeof docId === 'string' && document !== null && typeof document === 'object' && !Array.isArray(document)) {
      return { document: document as AnyDocument }
    }
  }
  throw new NarsilError(
    ErrorCodes.DOC_VALIDATION_FAILED,
    'Each entry of a batch update must be an object whose docId is a string and whose document is an object',
  )
}

async function prepareChunk(
  ctx: MutationContext,
  indexName: string,
  updates: unknown[],
  chunkStart: number,
  chunkEnd: number,
  hold: IndexHold | undefined,
  failed: BatchResult['failed'],
): Promise<PreparedUpdate[]> {
  const preparations: PendingUpdate[] = []
  for (let i = chunkStart; i < chunkEnd; i++) {
    const update = updates[i]
    const docId = reportedDocIdOf(update)
    try {
      const { document } = requireUpdateEntry(update)
      preparations.push({ docId, preparation: updatePreparationOf(ctx, indexName, docId, document) })
    } catch (err) {
      failed.push({ docId, error: asUpdateError(ctx, err) })
    }
  }
  let entry: PreparedWrites['entry']
  try {
    if (batchStopped(ctx)) throw shutDownError()
    const writes = await prepareDocumentWrites(
      ctx,
      indexName,
      preparations.map(pending => pending.preparation),
      hold,
      false,
    )
    entry = writes.entry
  } catch (err) {
    if (!stoppedByShutdown(ctx, err)) throw err
    failAsShutDown(failed, preparations, pendingDocIdOf)
    return []
  }
  const prepared: PreparedUpdate[] = []
  for (let position = 0; position < preparations.length; position++) {
    if (turnsAreBudgeted && turnIsSpent()) await yieldTurn()
    if (batchStopped(ctx)) {
      failAsShutDown(failed, prepared, pendingDocIdOf)
      failAsShutDown(failed, preparations, pendingDocIdOf, position)
      return []
    }
    const { docId, preparation } = preparations[position]
    try {
      if (preparation.failure !== undefined) throw preparation.failure
      prepared.push(await finishUpdate(ctx, indexName, entry, docId, preparation.document))
    } catch (err) {
      failed.push({ docId, error: asUpdateError(ctx, err) })
    }
  }
  return prepared
}

interface PendingUpdate {
  docId: string
  preparation: WritePreparation
}

function pendingDocIdOf(pending: { docId: string }): string {
  return pending.docId
}

export async function updateDocumentBatch(
  ctx: MutationContext,
  indexName: string,
  updates: Array<{ docId: string; document: AnyDocument }>,
  options?: WriteOptions,
  hold?: IndexHold,
): Promise<BatchResult> {
  ctx.guardShutdown()
  ctx.requireIndex(indexName)
  validateBatchList(updates, 'updates')

  const succeeded: string[] = []
  const failed: BatchResult['failed'] = []
  const touchedVectorFields = new Set<string>()
  for (let chunkStart = 0; chunkStart < updates.length; chunkStart += BATCH_CHUNK_SIZE) {
    if (batchStopped(ctx)) {
      failAsShutDown(failed, updates, reportedDocIdOf, chunkStart)
      break
    }
    const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, updates.length)
    const prepared = await prepareChunk(ctx, indexName, updates, chunkStart, chunkEnd, hold, failed)
    if (batchStopped(ctx)) {
      failAsShutDown(failed, prepared, pendingDocIdOf)
      failAsShutDown(failed, updates, reportedDocIdOf, chunkEnd)
      break
    }
    try {
      ctx.memoryWriteBlock?.refuseWhileFull(indexName)
    } catch (err) {
      const error = asUpdateError(ctx, err)
      for (const update of prepared) failed.push({ docId: update.docId, error })
      for (let i = chunkEnd; i < updates.length; i++) failed.push({ docId: reportedDocIdOf(updates[i]), error })
      break
    }

    const applies = prepared.map(update => applyUnlessShutDown(ctx, applyOfUpdate(ctx, indexName, update)))
    let failures: (ChunkFailure | null)[]
    try {
      failures = await recordChunk(ctx, indexName, prepared, applies)
      for (let i = prepared.length - 1; i >= 0; i--) {
        const failure = failures[i]
        if (failure === null) continue
        const update = prepared[i]
        try {
          await rollbackUpdatedDocument(
            ctx,
            indexName,
            update.docId,
            update.rollbackDoc,
            failure.error,
            update.preparedText,
            update.appliedRef,
            update.rollbackRef,
          )
        } catch (error) {
          failure.error = error
        }
      }
    } finally {
      for (const update of prepared) update.releaseVectorHolds?.()
    }

    const settled: PreparedUpdate[] = []
    for (let i = 0; i < prepared.length; i++) {
      const update = prepared[i]
      const failure = failures[i]
      if (failure !== null) {
        failed.push({ docId: update.docId, error: asUpdateError(ctx, failure.error) })
        continue
      }
      if (!update.buffered) settled.push(update)
      for (const [fieldPath, vec] of update.extractedVectors) {
        if (vec !== null) touchedVectorFields.add(fieldPath)
      }
      succeeded.push(update.docId)
    }
    await unlessShutDown(ctx, () => settleUpdates(ctx, indexName, settled, hold))

    if (chunkEnd < updates.length) {
      if (!batchStopped(ctx)) ctx.checkHeapPressure(indexName)
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  if (batchStopped(ctx)) return { succeeded, failed }
  const vectorIndexes = ctx.executor.getManager(indexName)?.getVectorIndexes()
  for (const fieldPath of touchedVectorFields) {
    vectorIndexes?.get(fieldPath)?.scheduleBuild()
  }
  ctx.checkHeapPressure(indexName)
  if (options?.wait === true) await unlessShutDown(ctx, () => awaitWriteVisibility(ctx, indexName))

  return { succeeded, failed }
}
