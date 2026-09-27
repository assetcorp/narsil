import { ErrorCodes, NarsilError } from '../../errors'
import { validateRequiredFields } from '../../schema/validator'
import type { BatchResult } from '../../types/results'
import type { AnyDocument, WriteOptions } from '../../types/schema'
import { BATCH_CHUNK_SIZE } from '../constants'
import { assertDocumentCarriesMappedVectors, embedDocumentFields } from '../embed'
import { validateDocId } from '../validation'
import {
  deleteNestedValue,
  extractVectorFromDoc,
  updateDocumentVectors,
  validateVectorDimensions,
} from '../vector-coordinator'
import type { MutationContext } from './context'
import { rollbackUpdatedDocument } from './durable-rollback'
import { recordChunk } from './record-batch'
import { awaitWriteVisibility } from './write-visibility'

type UpdatedIndexEntry = ReturnType<MutationContext['requireIndex']>

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

interface PreparedUpdate {
  docId: string
  document: AnyDocument
  partitionDoc: AnyDocument
  oldDocument: AnyDocument | undefined
  rollbackDoc: AnyDocument | undefined
  extractedVectors: Map<string, Float32Array | null>
  buffered: boolean
}

function asUpdateError(err: unknown): NarsilError {
  return err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_NOT_FOUND, String(err))
}

async function settleUpdate(ctx: MutationContext, indexName: string, prepared: PreparedUpdate): Promise<void> {
  try {
    await ctx.pluginRegistry.runHook('afterUpdate', {
      indexName,
      docId: prepared.docId,
      oldDocument: prepared.oldDocument ?? ({} as AnyDocument),
      newDocument: prepared.document,
    })
  } catch (err) {
    console.warn('afterUpdate plugin hook error:', err instanceof Error ? err.message : String(err))
  }

  await ctx.orchestrator.replicateToWorkers({
    type: 'update',
    indexName,
    docId: prepared.docId,
    document: prepared.partitionDoc,
    requestId: `replicate-update-${prepared.docId}`,
  })

  const vecIndexes = ctx.requireManager(indexName).getVectorIndexes()
  for (const [fieldPath, vec] of prepared.extractedVectors) {
    if (vec === null) continue
    vecIndexes.get(fieldPath)?.scheduleBuild()
  }
}

async function prepareUpdate(
  ctx: MutationContext,
  indexName: string,
  entry: UpdatedIndexEntry,
  docId: string,
  document: AnyDocument,
): Promise<PreparedUpdate> {
  ctx.guardShutdown()
  validateDocId(docId)

  const manager = ctx.requireManager(indexName)
  if (ctx.pluginRegistry.hasHooks('beforeUpdate')) {
    await ctx.pluginRegistry.runHook('beforeUpdate', {
      indexName,
      docId,
      oldDocument: manager.get(docId) ?? ({} as AnyDocument),
      newDocument: document,
    })
  }

  if (entry.config.required && entry.config.required.length > 0) {
    validateRequiredFields(document as Record<string, unknown>, entry.config.required)
  }

  if (entry.config.embedding) {
    if (entry.embeddingAdapter) {
      await embedDocumentFields(
        document as Record<string, unknown>,
        entry.config.embedding,
        entry.embeddingAdapter,
        ctx.abortController.signal,
      )
    } else {
      assertDocumentCarriesMappedVectors(
        document as Record<string, unknown>,
        entry.config.embedding,
        entry.embeddingAdapterName,
      )
    }
  }

  const oldDocument = manager.get(docId)
  const oldPartitionDoc = manager.getRef(docId)
  const rollbackDoc = oldPartitionDoc ? (structuredClone(oldPartitionDoc) as AnyDocument) : undefined

  const vecIndexes = manager.getVectorIndexes()
  const extractedVectors = new Map<string, Float32Array | null>()
  if (vecIndexes.size > 0) {
    const dimensionCheckVectors = new Map<string, Float32Array>()
    for (const fieldPath of entry.vectorFieldPaths) {
      const newVec = extractVectorFromDocForUpdate(document as Record<string, unknown>, fieldPath)
      extractedVectors.set(fieldPath, newVec)
      if (newVec) {
        dimensionCheckVectors.set(fieldPath, newVec)
      }
    }
    if (dimensionCheckVectors.size > 0) {
      validateVectorDimensions(dimensionCheckVectors, vecIndexes)
    }
  }

  const { partitionDoc } = prepareUpdatePartitionDoc(document as Record<string, unknown>, extractedVectors)
  return {
    docId,
    document,
    partitionDoc: partitionDoc as AnyDocument,
    oldDocument,
    rollbackDoc,
    extractedVectors,
    buffered: false,
  }
}

function applyOfUpdate(ctx: MutationContext, indexName: string, prepared: PreparedUpdate): () => Promise<void> {
  const manager = ctx.requireManager(indexName)
  const { docId, document, partitionDoc, rollbackDoc, extractedVectors } = prepared
  return async (): Promise<void> => {
    if (ctx.isRebalancing(indexName)) {
      const bufferedState = ctx.bufferedDocState(indexName, docId)
      const exists = bufferedState !== undefined ? bufferedState === 'present' : manager.has(docId)
      if (!exists) {
        manager.assertCapacity(ctx.pendingRebalanceWrites(indexName), ctx.rebalanceTargetPartitionCount(indexName))
      }
    }
    if (ctx.bufferIfRebalancing(indexName, { action: 'update', docId, document, indexName })) {
      prepared.buffered = true
      return
    }
    await ctx.executor.execute({ type: 'update', indexName, docId, document: partitionDoc, requestId: docId })
    try {
      updateDocumentVectors(docId, extractedVectors, manager.getVectorIndexes(), manager.partitionIdOf(docId))
    } catch (err) {
      if (rollbackDoc) {
        try {
          await ctx.executor.execute({ type: 'update', indexName, docId, document: rollbackDoc, requestId: docId })
        } catch (rollbackErr) {
          console.warn(
            `Rollback failed for doc "${docId}" during update atomicity:`,
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          )
        }
      }
      throw err
    }
  }
}

export async function updateDocument(
  ctx: MutationContext,
  indexName: string,
  docId: string,
  document: AnyDocument,
  options?: WriteOptions,
): Promise<void> {
  ctx.guardShutdown()
  const entry = ctx.requireIndex(indexName)
  const prepared = await prepareUpdate(ctx, indexName, entry, docId, document)
  const apply = applyOfUpdate(ctx, indexName, prepared)

  if (ctx.durability) {
    try {
      await ctx.durability.recordInsertOrUpdate(indexName, docId, document, apply)
    } catch (err) {
      await rollbackUpdatedDocument(ctx, indexName, docId, prepared.rollbackDoc, err)
      throw err
    }
  } else {
    await apply()
  }

  if (!prepared.buffered) await settleUpdate(ctx, indexName, prepared)
  ctx.checkHeapPressure(indexName)
  if (options?.wait === true) await awaitWriteVisibility(ctx, indexName)
}

export async function updateDocumentBatch(
  ctx: MutationContext,
  indexName: string,
  updates: Array<{ docId: string; document: AnyDocument }>,
  options?: WriteOptions,
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
    const prepared: PreparedUpdate[] = []
    for (let i = chunkStart; i < chunkEnd; i++) {
      try {
        prepared.push(await prepareUpdate(ctx, indexName, entry, updates[i].docId, updates[i].document))
      } catch (err) {
        failed.push({ docId: updates[i].docId, error: asUpdateError(err) })
      }
    }

    const applies = prepared.map(update => applyOfUpdate(ctx, indexName, update))
    const failures = await recordChunk(ctx, indexName, prepared, applies)

    for (let i = 0; i < prepared.length; i++) {
      const update = prepared[i]
      const failure = failures[i]
      if (failure !== null) {
        let error = failure.error
        try {
          await rollbackUpdatedDocument(ctx, indexName, update.docId, update.rollbackDoc, error)
        } catch (rollbackError) {
          error = rollbackError
        }
        failed.push({ docId: update.docId, error: asUpdateError(error) })
        continue
      }
      if (!update.buffered) await settleUpdate(ctx, indexName, update)
      for (const [fieldPath, vec] of update.extractedVectors) {
        if (vec !== null) touchedVectorFields.add(fieldPath)
      }
      succeeded.push(update.docId)
    }

    if (chunkEnd < updates.length) {
      ctx.checkHeapPressure(indexName)
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  for (const fieldPath of touchedVectorFields) {
    updateBatchVecIndexes.get(fieldPath)?.scheduleBuild()
  }
  ctx.checkHeapPressure(indexName)
  if (options?.wait === true) await awaitWriteVisibility(ctx, indexName)

  return { succeeded, failed }
}
