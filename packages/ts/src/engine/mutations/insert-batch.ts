import { MIN_DOCUMENTS_FOR_SEGMENTS, validateBatchList } from '#platform/optional-writes-host'
import type { BatchResult } from '../../types/results'
import type { AnyDocument, InsertOptions } from '../../types/schema'
import type { IndexHold } from '../index-hold'
import type { MutationContext } from './context'
import { finishInsertBatch, insertInChunks } from './insert-batch-chunks'
import { insertBatchViaSegments } from './insert-batch-segments'

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

  const failed: BatchResult['failed'] = []
  const inserts = await insertInChunks(ctx, indexName, documents, options, hold, true, failed)
  await finishInsertBatch(ctx, indexName, inserts, options)

  return { succeeded: inserts.succeeded, failed }
}
