import {
  admitBufferedUpsert,
  awaitWriteVisibility,
  BATCH_CHUNK_SIZE,
  deleteNestedValue,
  ErrorCodes,
  extractVectorFromDoc,
  getNestedValue,
  indexChangeOutsideExternalWaits,
  loadEmbedCode,
  NarsilError,
  prepareDocumentVectors,
  requireDocumentWithinSizeLimit,
  requireMatchingDocId,
  turnIsSpent,
  turnsAreBudgeted,
  updateDocumentVectors,
  validateBatchList,
  validateDocId,
  validateRequiredFields,
  validateVectorDimensions,
  yieldTurn,
} from '#platform/optional-writes-host'
import type { RemovedSpellings } from '../../core/partition/frozen/surface-slot'
import type { PreparedTextChange } from '../../core/partition/prepared-text'
import type { BatchResult } from '../../types/results'
import type { AnyDocument, WriteOptions } from '../../types/schema'
import type { ApplyMutation, MutationContext } from './context'
import { holdVectorsForRollback, rollbackUpdatedDocument } from './durable-rollback'
import { type ChunkFailure, recordChunk } from './record-batch'

type UpdatedIndexEntry = ReturnType<MutationContext['requireIndex']>

function prepareUpdatePartitionDoc(
  document: Record<string, unknown>,
  extractedVectors: Map<string, Float32Array | null>,
): { partitionDoc: Record<string, unknown> } {
  if (extractedVectors.size === 0) {
    return { partitionDoc: document }
  }

  let source = document
  const prototype: unknown = Object.getPrototypeOf(document)
  let topLevelVectors = prototype === Object.prototype || prototype === null
  for (const [fieldPath, vector] of extractedVectors) {
    if (fieldPath.includes('.') || vector === null) {
      topLevelVectors = false
      break
    }
    const value = document[fieldPath]
    if (Array.isArray(value) && Object.keys(value).length !== value.length) {
      topLevelVectors = false
      break
    }
  }
  if (topLevelVectors) {
    source = { ...document }
    for (const fieldPath of extractedVectors.keys()) delete source[fieldPath]
  }
  const partitionDoc = structuredClone(source)
  for (const [fieldPath, vector] of extractedVectors) {
    if (vector !== null || getNestedValue(partitionDoc, fieldPath) == null) deleteNestedValue(partitionDoc, fieldPath)
  }

  return { partitionDoc }
}

interface PreparedUpdate {
  rollbackRef?: AnyDocument
  appliedRef?: AnyDocument
  preparedText?: PreparedTextChange
  docId: string
  document: AnyDocument
  partitionDoc: AnyDocument
  oldDocument: AnyDocument | undefined
  rollbackDoc: AnyDocument | undefined
  extractedVectors: Map<string, Float32Array | null>
  removedSpellings: RemovedSpellings | undefined
  buffered: boolean
  releaseVectorHolds?: () => void
}

function asUpdateError(err: unknown): NarsilError {
  return err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_NOT_FOUND, String(err))
}

async function settleUpdate(ctx: MutationContext, indexName: string, prepared: PreparedUpdate): Promise<void> {
  await ctx.orchestrator.settlePublications(indexName)
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
  requireMatchingDocId(docId, document)

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
    const { assertDocumentCarriesMappedVectors, embedDocumentFields } = await loadEmbedCode()
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

  const sizing = requireDocumentWithinSizeLimit(document as Record<string, unknown>)
  if (sizing !== null) await sizing
  const vecIndexes = manager.getVectorIndexes()
  const extractedVectors = new Map<string, Float32Array | null>()
  if (vecIndexes.size > 0) {
    const dimensionCheckVectors = new Map<string, Float32Array>()
    for (const fieldPath of entry.vectorFieldPaths) {
      const newVec = extractVectorFromDoc(document as Record<string, unknown>, fieldPath)
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
    oldDocument: undefined,
    rollbackDoc: undefined,
    extractedVectors,
    removedSpellings: undefined,
    buffered: false,
  }
}

function applyOfUpdate(ctx: MutationContext, indexName: string, prepared: PreparedUpdate): ApplyMutation {
  const manager = ctx.requireManager(indexName)
  const { docId, document, partitionDoc, extractedVectors } = prepared
  const updateInIndex = () => {
    if (ctx.isRebalancing(indexName)) {
      const bufferedState = ctx.bufferedDocState(indexName, docId)
      const exists = bufferedState !== undefined ? bufferedState === 'present' : manager.has(docId)
      if (!exists) {
        admitBufferedUpsert(ctx, indexName, manager, docId)
      }
    }
    const queued = ctx.bufferIfRebalancing(indexName, { action: 'update', docId, document, indexName })
    if (queued !== undefined) {
      prepared.buffered = true
      return queued
    }
    if (manager.has(docId)) {
      for (const [fieldPath, vector] of extractedVectors) {
        if (vector !== null) manager.getVectorIndexes().get(fieldPath)?.requireRoomFor(docId, vector)
      }
    }
    prepared.oldDocument =
      extractedVectors.size > 0 || ctx.durability !== null || ctx.pluginRegistry.hasHooks('afterUpdate')
        ? manager.get(docId)
        : undefined
    prepared.rollbackDoc = prepared.oldDocument
    prepared.rollbackRef = ctx.durability === null ? undefined : manager.getRef(docId)
    if (ctx.durability !== null) prepared.releaseVectorHolds = holdVectorsForRollback(manager.getVectorIndexes(), docId)
    const stored = manager.update(docId, partitionDoc, {
      onRemovedSpellings: spellings => {
        prepared.removedSpellings = spellings
      },
      onPreparedText:
        extractedVectors.size > 0 || ctx.durability !== null
          ? change => {
              prepared.preparedText = change
            }
          : undefined,
    })
    try {
      updateDocumentVectors(docId, extractedVectors, manager.getVectorIndexes(), manager.partitionIdOf(docId))
    } catch (err) {
      if (prepared.rollbackDoc === undefined) {
        manager.remove(docId, undefined, { preparedText: { before: prepared.preparedText?.after } })
      } else {
        try {
          const previous = prepareDocumentVectors(prepared.rollbackDoc, ctx.requireIndex(indexName).vectorFieldPaths)
          manager.update(docId, previous.partitionDoc, {
            preparedText: { before: prepared.preparedText?.after, after: prepared.preparedText?.before },
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
    if (ctx.durability === null) prepared.preparedText = undefined
    else prepared.appliedRef = stored
    ctx.orchestrator.publishToWorkers({
      type: 'update',
      indexName,
      docId,
      document: partitionDoc,
      requestId: `replicate-update-${docId}`,
      removedSpellings: prepared.removedSpellings,
    })
  }
  return () => manager.publication.write(indexChangeOutsideExternalWaits(updateInIndex))
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
      await rollbackUpdatedDocument(
        ctx,
        indexName,
        docId,
        prepared.rollbackDoc,
        err,
        prepared.preparedText,
        prepared.appliedRef,
        prepared.rollbackRef,
      )
      throw err
    } finally {
      prepared.releaseVectorHolds?.()
    }
  } else {
    await apply()
  }

  if (!prepared.buffered) await settleUpdate(ctx, indexName, prepared)
  ctx.checkHeapPressure(indexName)
  if (options?.wait === true) await awaitWriteVisibility(ctx, indexName)
}

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

export async function updateDocumentBatch(
  ctx: MutationContext,
  indexName: string,
  updates: Array<{ docId: string; document: AnyDocument }>,
  options?: WriteOptions,
): Promise<BatchResult> {
  ctx.guardShutdown()
  const entry = ctx.requireIndex(indexName)
  validateBatchList(updates, 'updates')

  const succeeded: string[] = []
  const failed: BatchResult['failed'] = []

  const updateBatchManager = ctx.requireManager(indexName)
  const updateBatchVecIndexes = updateBatchManager.getVectorIndexes()
  const touchedVectorFields = new Set<string>()
  for (let chunkStart = 0; chunkStart < updates.length; chunkStart += BATCH_CHUNK_SIZE) {
    const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, updates.length)
    const prepared: PreparedUpdate[] = []
    for (let i = chunkStart; i < chunkEnd; i++) {
      if (turnsAreBudgeted && turnIsSpent()) await yieldTurn()
      const update: unknown = updates[i]
      const docId = reportedDocIdOf(update)
      try {
        const { document } = requireUpdateEntry(update)
        prepared.push(await prepareUpdate(ctx, indexName, entry, docId, document))
      } catch (err) {
        failed.push({ docId, error: asUpdateError(err) })
      }
    }

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

    for (let i = 0; i < prepared.length; i++) {
      const update = prepared[i]
      const failure = failures[i]
      if (failure !== null) {
        failed.push({ docId: update.docId, error: asUpdateError(failure.error) })
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
