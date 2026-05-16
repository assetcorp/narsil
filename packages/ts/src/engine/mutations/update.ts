import { ErrorCodes, NarsilError } from '../../errors'
import type { BatchResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import { embedDocumentFields } from '../embed'
import { BATCH_CHUNK_SIZE, validateDocId } from '../validation'
import {
  deleteNestedValue,
  extractVectorFromDoc,
  updateDocumentVectors,
  validateVectorDimensions,
} from '../vector-coordinator'
import type { MutationContext } from './context'

function extractVectorFromDocForUpdate(document: Record<string, unknown>, fieldPath: string): Float32Array | null {
  return extractVectorFromDoc(document, fieldPath)
}

function prepareUpdatePartitionDoc(
  document: Record<string, unknown>,
  extractedVectors: Map<string, Float32Array | null>,
): { partitionDoc: Record<string, unknown> } {
  if (extractedVectors.size === 0) {
    return { partitionDoc: document }
  }

  const partitionDoc = structuredClone(document)
  for (const fieldPath of extractedVectors.keys()) {
    deleteNestedValue(partitionDoc, fieldPath)
  }

  return { partitionDoc }
}

export async function updateDocument(
  ctx: MutationContext,
  indexName: string,
  docId: string,
  document: AnyDocument,
): Promise<void> {
  ctx.guardShutdown()
  const entry = ctx.requireIndex(indexName)
  validateDocId(docId)

  if (ctx.bufferIfRebalancing(indexName, { action: 'update', docId, document, indexName })) {
    return
  }

  if (entry.embeddingAdapter && entry.config.embedding) {
    await embedDocumentFields(
      document as Record<string, unknown>,
      entry.config.embedding,
      entry.embeddingAdapter,
      ctx.abortController.signal,
    )
  }

  const updateManager = ctx.requireManager(indexName)
  const oldDocument = updateManager.get(docId)
  const oldPartitionDoc = updateManager.getRef(docId)
  const rollbackDoc = oldPartitionDoc ? structuredClone(oldPartitionDoc) : undefined

  await ctx.pluginRegistry.runHook('beforeUpdate', {
    indexName,
    docId,
    oldDocument: oldDocument ?? ({} as AnyDocument),
    newDocument: document,
  })

  const updateVecIndexes = updateManager.getVectorIndexes()
  const updateExtractedVectors = new Map<string, Float32Array | null>()
  if (updateVecIndexes.size > 0) {
    const dimensionCheckVectors = new Map<string, Float32Array>()
    for (const fieldPath of entry.vectorFieldPaths) {
      const newVec = extractVectorFromDocForUpdate(document as Record<string, unknown>, fieldPath)
      updateExtractedVectors.set(fieldPath, newVec)
      if (newVec) {
        dimensionCheckVectors.set(fieldPath, newVec)
      }
    }
    if (dimensionCheckVectors.size > 0) {
      validateVectorDimensions(dimensionCheckVectors, updateVecIndexes)
    }
  }

  const { partitionDoc } = prepareUpdatePartitionDoc(document as Record<string, unknown>, updateExtractedVectors)

  await ctx.executor.execute({
    type: 'update',
    indexName,
    docId,
    document: partitionDoc as AnyDocument,
    requestId: docId,
  })

  try {
    updateDocumentVectors(docId, updateExtractedVectors, updateVecIndexes)
  } catch (err) {
    if (rollbackDoc) {
      try {
        await ctx.executor.execute({
          type: 'update',
          indexName,
          docId,
          document: rollbackDoc,
          requestId: docId,
        })
      } catch (rollbackErr) {
        console.warn(
          `Rollback failed for doc "${docId}" during update atomicity:`,
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        )
      }
    }
    throw err
  }

  try {
    await ctx.pluginRegistry.runHook('afterUpdate', {
      indexName,
      docId,
      oldDocument: oldDocument ?? ({} as AnyDocument),
      newDocument: document,
    })
  } catch (err) {
    console.warn('afterUpdate plugin hook error:', err instanceof Error ? err.message : String(err))
  }

  ctx.flushManager?.markDirty(indexName, 0)

  await ctx.orchestrator.replicateToWorkers({
    type: 'update',
    indexName,
    docId,
    document,
    requestId: `replicate-update-${docId}`,
  })

  for (const [fieldPath, vec] of updateExtractedVectors) {
    if (vec === null) continue
    const vecIndex = updateVecIndexes.get(fieldPath)
    if (vecIndex) {
      vecIndex.scheduleBuild()
    }
  }
}

export async function updateDocumentBatch(
  ctx: MutationContext,
  indexName: string,
  updates: Array<{ docId: string; document: AnyDocument }>,
): Promise<BatchResult> {
  ctx.guardShutdown()
  const entry = ctx.requireIndex(indexName)

  const succeeded: string[] = []
  const failed: BatchResult['failed'] = []

  const updateBatchManager = ctx.requireManager(indexName)
  const updateBatchVecIndexes = updateBatchManager.getVectorIndexes()
  const touchedVectorFields = new Set<string>()

  for (let chunkStart = 0; chunkStart < updates.length; chunkStart += BATCH_CHUNK_SIZE) {
    const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, updates.length)

    for (let i = chunkStart; i < chunkEnd; i++) {
      try {
        await updateDocument(ctx, indexName, updates[i].docId, updates[i].document)
        succeeded.push(updates[i].docId)

        if (updateBatchVecIndexes.size > 0) {
          for (const fieldPath of entry.vectorFieldPaths) {
            const vec = extractVectorFromDocForUpdate(updates[i].document as Record<string, unknown>, fieldPath)
            if (vec !== null) {
              touchedVectorFields.add(fieldPath)
            }
          }
        }
      } catch (err) {
        failed.push({
          docId: updates[i].docId,
          error: err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_NOT_FOUND, String(err)),
        })
      }
    }

    if (chunkEnd < updates.length) {
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  for (const fieldPath of touchedVectorFields) {
    const vecIndex = updateBatchVecIndexes.get(fieldPath)
    if (vecIndex) {
      vecIndex.scheduleBuild()
    }
  }

  return { succeeded, failed }
}
