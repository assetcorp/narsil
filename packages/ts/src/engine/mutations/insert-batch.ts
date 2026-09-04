import type { BatchResult } from '../../types/results'
import type { AnyDocument, InsertOptions } from '../../types/schema'
import { BATCH_CHUNK_SIZE, MIN_DOCUMENTS_FOR_SEGMENTS } from '../constants'
import { validateDocId } from '../validation'
import { insertDocumentVectors, prepareDocumentVectors, validateVectorDimensions } from '../vector-coordinator'
import type { MutationContext } from './context'
import { rollbackInsertedDocument } from './durable-rollback'
import {
  admitInsert,
  asBatchInsertError,
  collectRequiredFieldFailures,
  embedChunkDocuments,
  providedDocId,
} from './insert-admission'
import { insertBatchViaSegments } from './insert-batch-segments'
import { replicateAsSegments } from './segment-replication'

export async function insertDocumentBatch(
  ctx: MutationContext,
  indexName: string,
  documents: AnyDocument[],
  options?: InsertOptions,
): Promise<BatchResult> {
  ctx.guardShutdown()
  const entry = ctx.requireIndex(indexName)

  await ctx.orchestrator.scaleOutBeforeBatch(indexName, documents.length)

  if (
    documents.length >= MIN_DOCUMENTS_FOR_SEGMENTS &&
    !ctx.isRebalancing(indexName) &&
    ctx.orchestrator.segmentBuildConcurrency(indexName) > 0
  ) {
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

        let batchInserted = false
        let batchBuffered = false
        const applyBatchInsert = async (): Promise<void> => {
          admitInsert(ctx, indexName, batchManager, batchDocId)
          if (
            ctx.bufferIfRebalancing(indexName, {
              action: 'insert',
              docId: batchDocId,
              document: documents[i],
              indexName,
            })
          ) {
            batchBuffered = true
            return
          }
          await ctx.executor.execute({
            type: 'insert',
            indexName,
            docId: batchDocId,
            document: partitionDoc as AnyDocument,
            requestId: batchDocId,
            skipClone: extractedVectors.size > 0 ? true : options?.skipClone,
          })
          batchInserted = true
          try {
            insertDocumentVectors(batchDocId, extractedVectors, batchVecIndexes, batchManager.partitionIdOf(batchDocId))
          } catch (vecErr) {
            try {
              await ctx.executor.execute({ type: 'remove', indexName, docId: batchDocId, requestId: batchDocId })
              batchInserted = false
            } catch (rollbackErr) {
              console.warn(
                `Rollback failed for doc "${batchDocId}" during batch insert atomicity:`,
                rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
              )
            }
            throw vecErr
          }
        }

        if (ctx.durability) {
          try {
            await ctx.durability.recordInsertOrUpdate(indexName, batchDocId, documents[i], applyBatchInsert)
          } catch (durableErr) {
            await rollbackInsertedDocument(ctx, indexName, batchDocId, batchInserted, durableErr)
            throw durableErr
          }
        } else {
          await applyBatchInsert()
        }

        if (batchBuffered) {
          bufferedDocIds.add(batchDocId)
          succeeded.push(batchDocId)
          succeededDocs.push(documents[i])
          continue
        }

        for (const fieldPath of extractedVectors.keys()) {
          touchedVectorFields.add(fieldPath)
        }

        if (hasAfterHook) {
          try {
            await ctx.pluginRegistry.runHook('afterInsert', { indexName, docId: batchDocId, document: documents[i] })
          } catch (err) {
            console.warn('afterInsert plugin hook error:', err instanceof Error ? err.message : String(err))
          }
        }

        succeeded.push(batchDocId)
        succeededDocs.push(documents[i])
      } catch (err) {
        failed.push({ docId: batchDocId, error: asBatchInsertError(err) })
      }
    }

    if (chunkEnd < documents.length) {
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

  const replicatedAsSegments = await replicateAsSegments(
    ctx,
    indexName,
    replicableIds,
    replicableDocs,
    options?.skipClone,
  )

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
  await ctx.orchestrator.scaleOutReadyIndexes()

  return { succeeded, failed }
}
