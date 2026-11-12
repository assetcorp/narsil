import {
  admitInsert,
  awaitWriteVisibility,
  BATCH_CHUNK_SIZE,
  MIN_DOCUMENTS_FOR_SEGMENTS,
  prepareDocumentVectors,
  turnIsSpent,
  turnsAreBudgeted,
  validateBatchList,
  validateVectorDimensions,
  yieldTurn,
} from '#platform/optional-writes-host'
import type { BatchResult } from '../../types/results'
import type { AnyDocument, InsertOptions } from '../../types/schema'
import type { IndexHold } from '../index-hold'
import { asBatchInsertError } from './batch-admissions'
import type { MutationContext } from './context'
import { type AdmittedInsert, prepareInsertDocuments } from './insert-batch-admission'
import { applyInsertChunk } from './insert-batch-apply'
import { runAfterInsertHooks } from './insert-batch-documents'
import { insertBatchViaSegments } from './insert-batch-segments'

async function admitChunk(
  ctx: MutationContext,
  indexName: string,
  documents: AnyDocument[],
  chunkStart: number,
  chunkEnd: number,
  hold: IndexHold | undefined,
  failed: BatchResult['failed'],
): Promise<AdmittedInsert[]> {
  const { entry, candidates } = await prepareInsertDocuments(
    ctx,
    indexName,
    documents,
    chunkStart,
    chunkEnd,
    hold,
    failed,
  )
  const manager = ctx.requireManager(indexName)
  const vecIndexes = manager.getVectorIndexes()
  const vectorFieldPaths = vecIndexes.size > 0 ? entry.vectorFieldPaths : new Set<string>()
  const admitted: AdmittedInsert[] = []
  for (const { docId, document } of candidates) {
    if (turnsAreBudgeted && turnIsSpent()) await yieldTurn()
    if (ctx.abortController.signal.aborted) break
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
      failed.push({ docId, error: asBatchInsertError(err) })
    }
  }
  return admitted
}

export async function insertDocumentBatch(
  ctx: MutationContext,
  indexName: string,
  documents: AnyDocument[],
  options?: InsertOptions,
  hold?: IndexHold,
): Promise<BatchResult> {
  ctx.guardShutdown()
  ctx.requireIndex(indexName)
  validateBatchList(documents, 'documents')

  await ctx.orchestrator.scaleOutBeforeBatch(indexName, documents.length)

  const copiesBuildSegments = ctx.orchestrator.segmentBuildConcurrency(indexName) > 0

  if (documents.length >= MIN_DOCUMENTS_FOR_SEGMENTS && !ctx.isRebalancing(indexName) && copiesBuildSegments) {
    return insertBatchViaSegments(ctx, indexName, documents, options, hold)
  }

  const succeeded: string[] = []
  const failed: BatchResult['failed'] = []
  const inserted: AdmittedInsert[] = []
  const touchedVectorFields = new Set<string>()

  for (let chunkStart = 0; chunkStart < documents.length; chunkStart += BATCH_CHUNK_SIZE) {
    if (ctx.abortController.signal.aborted) break

    const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, documents.length)
    const prepared = await admitChunk(ctx, indexName, documents, chunkStart, chunkEnd, hold, failed)

    if (prepared.length > 0) {
      const applications = await applyInsertChunk(ctx, indexName, prepared, options)
      for (let i = 0; i < prepared.length; i++) {
        const doc = prepared[i]
        const application = applications[i]
        if (application.status === 'skipped') continue
        if (application.status === 'failed') {
          failed.push({ docId: doc.docId, error: asBatchInsertError(application.error) })
          continue
        }
        succeeded.push(doc.docId)
        if (application.status === 'buffered') continue
        for (const fieldPath of doc.extractedVectors.keys()) touchedVectorFields.add(fieldPath)
        inserted.push(doc)
      }
    }

    if (chunkEnd < documents.length) {
      ctx.checkHeapPressure(indexName)
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  const vecIndexes = ctx.requireManager(indexName).getVectorIndexes()
  for (const fieldPath of touchedVectorFields) {
    vecIndexes.get(fieldPath)?.scheduleBuild()
  }

  ctx.checkWatermark(indexName, succeeded)
  ctx.checkHeapPressure(indexName)
  await ctx.orchestrator.scaleOutReadyIndexes()
  if (options?.wait === true) await awaitWriteVisibility(ctx, indexName)
  await runAfterInsertHooks(ctx, indexName, inserted, hold)

  return { succeeded, failed }
}
