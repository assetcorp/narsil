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
import { prepareDocumentWrites, type WritePreparation } from './write-preparation'

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
  const preparations: { docId: string; preparation: WritePreparation }[] = []
  for (let i = chunkStart; i < chunkEnd; i++) {
    const update = updates[i]
    const docId = reportedDocIdOf(update)
    try {
      const { document } = requireUpdateEntry(update)
      preparations.push({ docId, preparation: updatePreparationOf(ctx, indexName, docId, document) })
    } catch (err) {
      failed.push({ docId, error: asUpdateError(err) })
    }
  }
  const entry = await prepareDocumentWrites(
    ctx,
    indexName,
    preparations.map(pending => pending.preparation),
    hold,
    false,
  )
  const prepared: PreparedUpdate[] = []
  for (const { docId, preparation } of preparations) {
    if (turnsAreBudgeted && turnIsSpent()) await yieldTurn()
    try {
      if (preparation.failure !== undefined) throw preparation.failure
      prepared.push(await finishUpdate(ctx, indexName, entry, docId, preparation.document))
    } catch (err) {
      failed.push({ docId, error: asUpdateError(err) })
    }
  }
  return prepared
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
    const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, updates.length)
    const prepared = await prepareChunk(ctx, indexName, updates, chunkStart, chunkEnd, hold, failed)

    const applies = prepared.map(update => applyOfUpdate(ctx, indexName, update))
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
        failed.push({ docId: update.docId, error: asUpdateError(failure.error) })
        continue
      }
      if (!update.buffered) settled.push(update)
      for (const [fieldPath, vec] of update.extractedVectors) {
        if (vec !== null) touchedVectorFields.add(fieldPath)
      }
      succeeded.push(update.docId)
    }
    await settleUpdates(ctx, indexName, settled, hold)

    if (chunkEnd < updates.length) {
      ctx.checkHeapPressure(indexName)
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  const vectorIndexes = ctx.executor.getManager(indexName)?.getVectorIndexes()
  for (const fieldPath of touchedVectorFields) {
    vectorIndexes?.get(fieldPath)?.scheduleBuild()
  }
  ctx.checkHeapPressure(indexName)
  if (options?.wait === true) await awaitWriteVisibility(ctx, indexName)

  return { succeeded, failed }
}
