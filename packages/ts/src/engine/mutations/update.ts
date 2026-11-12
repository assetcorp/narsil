import {
  admitBufferedUpsert,
  awaitWriteVisibility,
  deleteNestedValue,
  ErrorCodes,
  extractVectorFromDoc,
  getNestedValue,
  indexChangeOutsideExternalWaits,
  NarsilError,
  prepareDocumentVectors,
  prepareDocumentWrites,
  requireDocumentWithinSizeLimit,
  requireMatchingDocId,
  updateDocumentVectors,
  validateDocId,
  validateVectorDimensions,
} from '#platform/optional-writes-host'
import type { RemovedSpellings } from '../../core/partition/frozen/surface-slot'
import type { PreparedTextChange } from '../../core/partition/prepared-text'
import type { AnyDocument, WriteOptions } from '../../types/schema'
import type { IndexHold } from '../index-hold'
import type { ApplyMutation, MutationContext } from './context'
import { holdVectorsForRollback, rollbackUpdatedDocument } from './durable-rollback'
import type { WritePreparation } from './write-preparation'

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

export interface PreparedUpdate {
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

export function asUpdateError(err: unknown): NarsilError {
  return err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_NOT_FOUND, String(err))
}

export async function settleUpdate(ctx: MutationContext, indexName: string, prepared: PreparedUpdate): Promise<void> {
  await ctx.orchestrator.settlePublications(indexName)
  const vecIndexes = ctx.requireManager(indexName).getVectorIndexes()
  for (const [fieldPath, vec] of prepared.extractedVectors) {
    if (vec === null) continue
    vecIndexes.get(fieldPath)?.scheduleBuild()
  }
}

export async function runAfterUpdateHooks(
  ctx: MutationContext,
  indexName: string,
  updates: PreparedUpdate[],
  hold: IndexHold | undefined,
): Promise<void> {
  if (updates.length === 0 || !ctx.pluginRegistry.hasHooks('afterUpdate')) return
  const runHooks = async (): Promise<void> => {
    for (const update of updates) {
      try {
        await ctx.pluginRegistry.runHook('afterUpdate', {
          indexName,
          docId: update.docId,
          oldDocument: update.oldDocument ?? ({} as AnyDocument),
          newDocument: update.document,
        })
      } catch (err) {
        console.warn('afterUpdate plugin hook error:', err instanceof Error ? err.message : String(err))
      }
    }
  }
  if (hold === undefined) await runHooks()
  else hold.afterRelease(runHooks)
}

export function updatePreparationOf(
  ctx: MutationContext,
  indexName: string,
  docId: string,
  document: AnyDocument,
): WritePreparation {
  ctx.guardShutdown()
  validateDocId(docId)
  requireMatchingDocId(docId, document)
  if (!ctx.pluginRegistry.hasHooks('beforeUpdate')) return { document, beforeWrite: null, failure: undefined }
  const oldDocument = ctx.requireManager(indexName).get(docId) ?? ({} as AnyDocument)
  const beforeWrite = () =>
    ctx.pluginRegistry.runHook('beforeUpdate', { indexName, docId, oldDocument, newDocument: document })
  return { document, beforeWrite, failure: undefined }
}

export async function finishUpdate(
  ctx: MutationContext,
  indexName: string,
  entry: UpdatedIndexEntry,
  docId: string,
  document: AnyDocument,
): Promise<PreparedUpdate> {
  const sizing = requireDocumentWithinSizeLimit(document as Record<string, unknown>)
  if (sizing !== null) await sizing
  const manager = ctx.requireManager(indexName)
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

export function applyOfUpdate(ctx: MutationContext, indexName: string, prepared: PreparedUpdate): ApplyMutation {
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
  hold?: IndexHold,
): Promise<void> {
  ctx.guardShutdown()
  ctx.requireIndex(indexName)
  const preparation = updatePreparationOf(ctx, indexName, docId, document)
  const entry = await prepareDocumentWrites(ctx, indexName, [preparation], hold, false)
  if (preparation.failure !== undefined) throw preparation.failure
  const prepared = await finishUpdate(ctx, indexName, entry, docId, document)
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
  await runAfterUpdateHooks(ctx, indexName, prepared.buffered ? [] : [prepared], hold)
}
