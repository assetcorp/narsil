import type { BatchResult } from '../../types/results'
import type { AnyDocument, InsertOptions } from '../../types/schema'
import { BATCH_CHUNK_SIZE, MIN_DOCUMENTS_FOR_SEGMENTS } from '../constants'
import { validateDocId } from '../validation'
import { prepareDocumentVectors, validateVectorDimensions } from '../vector-coordinator'
import type { MutationContext } from './context'
import {
  admitInsert,
  asBatchInsertError,
  collectRequiredFieldFailures,
  embedChunkDocuments,
  providedDocId,
} from './insert-admission'
import type { AdmittedInsert } from './insert-batch-admission'
import { applyInsertChunk } from './insert-batch-apply'
import { insertBatchViaSegments } from './insert-batch-segments'
import { replicateAsSegments } from './segment-replication'
import { awaitWriteVisibility } from './write-visibility'

export async function insertDocumentBatch(
  ctx: MutationContext,
  indexName: string,
  documents: AnyDocument[],
  options?: InsertOptions,
): Promise<BatchResult> {
  ctx.guardShutdown()
  const entry = ctx.requireIndex(indexName)

  await ctx.orchestrator.scaleOutBeforeBatch(indexName, documents.length)

  const copiesBuildSegments = ctx.orchestrator.segmentBuildConcurrency(indexName) > 0

  if (documents.length >= MIN_DOCUMENTS_FOR_SEGMENTS && !ctx.isRebalancing(indexName) && copiesBuildSegments) {
    return insertBatchViaSegments(ctx, indexName, documents, options)
  }

  const succeeded: string[] = []
  const succeededDocs: AnyDocument[] = []
  const failed: BatchResult['failed'] = []
  const hasBeforeHook = ctx.pluginRegistry.hasHooks('beforeInsert')
  const hasAfterHook = ctx.pluginRegistry.hasHooks('afterInsert')
  const required = entry.config.required

  const batchManager = ctx.requireManager(indexName)
  const batchVecIndexes = batchManager.getVectorIndexes()
  const batchVectorFieldPaths = batchVecIndexes.size > 0 ? entry.vectorFieldPaths : new Set<string>()
  const touchedVectorFields = new Set<string>()
  const bufferedDocIds = new Set<string>()

  for (let chunkStart = 0; chunkStart < documents.length; chunkStart += BATCH_CHUNK_SIZE) {
    if (ctx.abortController.signal.aborted) break

    const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, documents.length)
    const chunkFailedIndexes = new Set<number>()

    if (required && required.length > 0) {
      collectRequiredFieldFailures(documents, chunkStart, chunkEnd, required, chunkFailedIndexes, failed)
    }
    await embedChunkDocuments(
      entry,
      documents,
      chunkStart,
      chunkEnd,
      ctx.abortController.signal,
      chunkFailedIndexes,
      failed,
    )

    async function applyPrepared(prepared: AdmittedInsert[]): Promise<void> {
      const applications = await applyInsertChunk(ctx, indexName, prepared, options)
      for (let i = 0; i < prepared.length; i++) {
        const doc = prepared[i]
        const application = applications[i]
        if (application.status === 'skipped') continue
        if (application.status === 'failed') {
          failed.push({ docId: doc.docId, error: asBatchInsertError(application.error) })
          continue
        }
        if (application.status === 'buffered') {
          bufferedDocIds.add(doc.docId)
          succeeded.push(doc.docId)
          succeededDocs.push(doc.partitionDoc)
          continue
        }

        for (const fieldPath of doc.extractedVectors.keys()) {
          touchedVectorFields.add(fieldPath)
        }

        if (hasAfterHook) {
          try {
            await ctx.pluginRegistry.runHook('afterInsert', { indexName, docId: doc.docId, document: doc.document })
          } catch (err) {
            console.warn('afterInsert plugin hook error:', err instanceof Error ? err.message : String(err))
          }
        }

        succeeded.push(doc.docId)
        succeededDocs.push(doc.partitionDoc)
      }
    }

    const prepared: AdmittedInsert[] = []
    for (let i = chunkStart; i < chunkEnd; i++) {
      if (ctx.abortController.signal.aborted) break
      if (chunkFailedIndexes.has(i)) continue

      const batchDocId = providedDocId(documents[i]) ?? ctx.idGenerator()
      try {
        validateDocId(batchDocId)

        if (hasBeforeHook) {
          await ctx.pluginRegistry.runHook('beforeInsert', { indexName, docId: batchDocId, document: documents[i] })
        }

        const { partitionDoc, extractedVectors } = prepareDocumentVectors(
          documents[i] as Record<string, unknown>,
          batchVectorFieldPaths,
        )

        if (extractedVectors.size > 0) {
          validateVectorDimensions(extractedVectors, batchVecIndexes)
        }

        admitInsert(ctx, indexName, batchManager, batchDocId)
        prepared.push({
          docId: batchDocId,
          document: documents[i],
          partitionDoc: partitionDoc as AnyDocument,
          extractedVectors,
        })
      } catch (err) {
        failed.push({ docId: batchDocId, error: asBatchInsertError(err) })
      }
    }

    if (prepared.length > 0) await applyPrepared(prepared)

    if (chunkEnd < documents.length) {
      ctx.checkHeapPressure(indexName)
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  const replicableIds: string[] = []
  const replicableDocs: AnyDocument[] = []
  for (let i = 0; i < succeeded.length; i++) {
    if (bufferedDocIds.has(succeeded[i])) continue
    replicableIds.push(succeeded[i])
    replicableDocs.push(succeededDocs[i])
  }

  const replicatedAsSegments =
    copiesBuildSegments &&
    (await replicateAsSegments(ctx, indexName, replicableIds, replicableDocs, options?.skipClone))

  if (!replicatedAsSegments) {
    for (let i = 0; i < replicableIds.length; i++) {
      await ctx.orchestrator.replicateToWorkers({
        type: 'insert',
        indexName,
        docId: replicableIds[i],
        document: replicableDocs[i],
        requestId: `replicate-insert-${replicableIds[i]}`,
        skipClone: options?.skipClone,
      })
    }
  }

  for (const fieldPath of touchedVectorFields) {
    const vecIndex = batchVecIndexes.get(fieldPath)
    if (vecIndex) {
      vecIndex.scheduleBuild()
    }
  }

  ctx.checkWatermark(indexName)
  ctx.checkHeapPressure(indexName)
  await ctx.orchestrator.scaleOutReadyIndexes()
  if (options?.wait === true) await awaitWriteVisibility(ctx, indexName)

  return { succeeded, failed }
}
