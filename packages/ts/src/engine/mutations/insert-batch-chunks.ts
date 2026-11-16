import {
  admitInsert,
  awaitWriteVisibility,
  BATCH_CHUNK_SIZE,
  prepareDocumentVectors,
  turnIsSpent,
  turnsAreBudgeted,
  validateVectorDimensions,
  yieldTurn,
} from '#platform/optional-writes-host'
import type { BatchResult } from '../../types/results'
import type { AnyDocument, InsertOptions } from '../../types/schema'
import type { WriteEmbedding } from '../embed'
import type { IndexHold } from '../index-hold'
import { asBatchInsertError } from './batch-admissions'
import { batchStopped, failAsShutDown, providedDocIdOrEmpty, unlessShutDown } from './batch-shutdown'
import type { MutationContext } from './context'
import {
  type AdmittedInsert,
  admittedDocIdOf,
  candidateDocIdOf,
  prepareInsertDocuments,
} from './insert-batch-admission'
import { applyInsertChunk } from './insert-batch-apply'
import { runAfterInsertHooks } from './insert-batch-documents'
import { embeddingOfDocuments } from './write-preparation'

export interface ChunkedInserts {
  succeeded: string[]
  touchedVectorFields: Set<string>
}

async function admitChunk(
  ctx: MutationContext,
  indexName: string,
  documents: AnyDocument[],
  chunkStart: number,
  chunkEnd: number,
  hold: IndexHold | undefined,
  hooked: boolean,
  failed: BatchResult['failed'],
  earlier: WriteEmbedding | null,
): Promise<AdmittedInsert[]> {
  const prepared = await prepareInsertDocuments(
    ctx,
    indexName,
    documents,
    chunkStart,
    chunkEnd,
    hold,
    hooked,
    failed,
    earlier,
  )
  if (prepared === null) return []
  const { entry, candidates } = prepared
  const admitted: AdmittedInsert[] = []
  if (batchStopped(ctx)) {
    failAsShutDown(failed, candidates, candidateDocIdOf)
    return admitted
  }
  const manager = ctx.requireManager(indexName)
  const vecIndexes = manager.getVectorIndexes()
  const vectorFieldPaths = vecIndexes.size > 0 ? entry.vectorFieldPaths : new Set<string>()
  for (let position = 0; position < candidates.length; position++) {
    if (turnsAreBudgeted && turnIsSpent()) await yieldTurn()
    if (batchStopped(ctx)) {
      failAsShutDown(failed, admitted, admittedDocIdOf)
      failAsShutDown(failed, candidates, candidateDocIdOf, position)
      return []
    }
    const { docId, document } = candidates[position]
    try {
      const { partitionDoc, extractedVectors } = prepareDocumentVectors(
        document as Record<string, unknown>,
        vectorFieldPaths,
      )
      if (extractedVectors.size > 0) {
        validateVectorDimensions(extractedVectors, vecIndexes)
      }
      admitInsert(ctx, indexName, manager, docId)
      admitted.push({ docId, document, partitionDoc: partitionDoc as AnyDocument, extractedVectors })
    } catch (err) {
      failed.push({ docId, error: asBatchInsertError(ctx, err) })
    }
  }
  return admitted
}

export async function insertInChunks(
  ctx: MutationContext,
  indexName: string,
  documents: AnyDocument[],
  options: InsertOptions | undefined,
  hold: IndexHold | undefined,
  hooked: boolean,
  failed: BatchResult['failed'],
  embedded: WriteEmbedding | null = null,
): Promise<ChunkedInserts> {
  const succeeded: string[] = []
  const touchedVectorFields = new Set<string>()

  for (let chunkStart = 0; chunkStart < documents.length; chunkStart += BATCH_CHUNK_SIZE) {
    if (batchStopped(ctx)) {
      failAsShutDown(failed, documents, providedDocIdOrEmpty, chunkStart)
      break
    }

    const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, documents.length)
    const earlier = embeddingOfDocuments(embedded, documents.slice(chunkStart, chunkEnd))
    const prepared = await admitChunk(ctx, indexName, documents, chunkStart, chunkEnd, hold, hooked, failed, earlier)
    if (batchStopped(ctx)) {
      failAsShutDown(failed, prepared, admittedDocIdOf)
      failAsShutDown(failed, documents, providedDocIdOrEmpty, chunkEnd)
      break
    }
    try {
      if (prepared.length > 0) ctx.memoryWriteBlock?.refuseWhileFull(indexName)
    } catch (err) {
      const error = asBatchInsertError(ctx, err)
      for (const doc of prepared) failed.push({ docId: doc.docId, error })
      for (let i = chunkEnd; i < documents.length; i++) {
        failed.push({ docId: providedDocIdOrEmpty(documents[i]), error })
      }
      break
    }

    if (prepared.length > 0) {
      const applications = await applyInsertChunk(ctx, indexName, prepared, options)
      const inserted: AdmittedInsert[] = []
      for (let i = 0; i < prepared.length; i++) {
        const doc = prepared[i]
        const application = applications[i]
        if (application.status === 'failed') {
          failed.push({ docId: doc.docId, error: asBatchInsertError(ctx, application.error) })
          continue
        }
        succeeded.push(doc.docId)
        if (application.status === 'buffered') continue
        for (const fieldPath of doc.extractedVectors.keys()) touchedVectorFields.add(fieldPath)
        inserted.push(doc)
      }
      await runAfterInsertHooks(ctx, indexName, inserted, hold)
    }

    if (chunkEnd < documents.length) {
      if (!batchStopped(ctx)) ctx.checkHeapPressure(indexName)
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  return { succeeded, touchedVectorFields }
}

export async function finishInsertBatch(
  ctx: MutationContext,
  indexName: string,
  inserts: ChunkedInserts,
  options: InsertOptions | undefined,
): Promise<void> {
  if (batchStopped(ctx)) return
  const vecIndexes = ctx.executor.getManager(indexName)?.getVectorIndexes()
  for (const fieldPath of inserts.touchedVectorFields) {
    vecIndexes?.get(fieldPath)?.scheduleBuild()
  }

  ctx.checkWatermark(indexName, inserts.succeeded)
  ctx.checkHeapPressure(indexName)
  await unlessShutDown(ctx, async () => {
    await ctx.orchestrator.scaleOutReadyIndexes()
    if (options?.wait === true && !batchStopped(ctx)) await awaitWriteVisibility(ctx, indexName)
  })
}
