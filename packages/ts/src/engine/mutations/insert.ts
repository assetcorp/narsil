import { indexChangeOutsideExternalWaits } from '#platform/turn-budget'
import type { PreparedTextChange } from '../../core/partition/prepared-text'
import { requireDocumentWithinSizeLimit } from '../../schema/validator'
import type { AnyDocument, InsertOptions } from '../../types/schema'
import type { IndexHold } from '../index-hold'
import { loadOptionalWrites } from '../optional-writes-code'
import { validateDocId } from '../validation'
import { insertDocumentVectors, prepareDocumentVectors, validateVectorDimensions } from '../vector-coordinator'
import type { ApplyMutation, MutationContext } from './context'
import { admitInsert, providedDocId, requireMatchingDocId } from './insert-admission'
import { prepareDocumentWrite } from './write-preparation'
import { awaitWriteVisibility } from './write-visibility'

export async function insertDocument(
  ctx: MutationContext,
  indexName: string,
  document: AnyDocument,
  docId?: string,
  options?: InsertOptions,
  hold?: IndexHold,
): Promise<string> {
  ctx.guardShutdown()
  ctx.requireIndex(indexName)

  if (docId !== undefined) requireMatchingDocId(docId, document)
  const resolvedDocId = docId ?? providedDocId(document) ?? ctx.idGenerator()
  validateDocId(resolvedDocId)

  const entry = await prepareDocumentWrite(
    ctx,
    indexName,
    document,
    hold,
    ctx.pluginRegistry.hasHooks('beforeInsert')
      ? () => ctx.pluginRegistry.runHook('beforeInsert', { indexName, docId: resolvedDocId, document })
      : null,
  )

  const sizing = requireDocumentWithinSizeLimit(document as Record<string, unknown>)
  if (sizing !== null) await sizing
  const insertManager = ctx.requireManager(indexName)
  admitInsert(ctx, indexName, insertManager, resolvedDocId)
  const insertVecIndexes = insertManager.getVectorIndexes()

  const { partitionDoc, extractedVectors } = prepareDocumentVectors(
    document as Record<string, unknown>,
    entry.vectorFieldPaths,
  )

  if (extractedVectors.size > 0) {
    validateVectorDimensions(extractedVectors, insertVecIndexes)
  }

  let inserted = false
  let buffered = false
  let preparedText: PreparedTextChange | undefined
  let appliedRef: AnyDocument | undefined
  const insertIntoIndex = () => {
    admitInsert(ctx, indexName, insertManager, resolvedDocId)
    const queued = ctx.bufferIfRebalancing(indexName, { action: 'insert', docId: resolvedDocId, document, indexName })
    if (queued !== undefined) {
      buffered = true
      return queued
    }
    const stored = insertManager.insert(resolvedDocId, partitionDoc as AnyDocument, {
      skipClone: extractedVectors.size > 0 ? true : options?.skipClone,
      onPreparedText:
        extractedVectors.size > 0 || ctx.durability !== null
          ? change => {
              preparedText = change
            }
          : undefined,
    })
    inserted = true
    try {
      insertDocumentVectors(
        resolvedDocId,
        extractedVectors,
        insertVecIndexes,
        insertManager.partitionIdOf(resolvedDocId),
      )
    } catch (err) {
      try {
        insertManager.remove(resolvedDocId, undefined, { preparedText: { before: preparedText?.after } })
        inserted = false
      } catch (rollbackErr) {
        console.warn(
          `Rollback failed for doc "${resolvedDocId}" during insert atomicity:`,
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        )
      }
      throw err
    }
    appliedRef = ctx.durability === null ? undefined : stored
    ctx.orchestrator.publishToWorkers({
      type: 'insert',
      indexName,
      docId: resolvedDocId,
      document: partitionDoc as AnyDocument,
      requestId: `replicate-insert-${resolvedDocId}`,
      skipClone: options?.skipClone,
    })
  }
  const applyInsert: ApplyMutation = () =>
    insertManager.publication.write(indexChangeOutsideExternalWaits(insertIntoIndex))

  if (ctx.durability) {
    const { rollbackInsertedDocument } = await loadOptionalWrites()
    try {
      await ctx.durability.recordInsertOrUpdate(indexName, resolvedDocId, document, applyInsert)
    } catch (err) {
      await rollbackInsertedDocument(ctx, indexName, resolvedDocId, inserted, err, preparedText, appliedRef)
      throw err
    }
  } else {
    if (extractedVectors.size > 0) await loadOptionalWrites()
    await applyInsert()
  }

  if (buffered) {
    ctx.checkWatermark(indexName, resolvedDocId)
    ctx.checkHeapPressure(indexName)
    if (options?.wait === true) await awaitWriteVisibility(ctx, indexName)
    return resolvedDocId
  }

  await ctx.orchestrator.settlePublications(indexName)

  for (const fieldPath of extractedVectors.keys()) {
    const vecIndex = insertVecIndexes.get(fieldPath)
    if (vecIndex) {
      vecIndex.scheduleBuild()
    }
  }

  ctx.checkWatermark(indexName, resolvedDocId)
  ctx.checkHeapPressure(indexName)
  await ctx.orchestrator.scaleOutReadyIndexes()
  if (options?.wait === true) await awaitWriteVisibility(ctx, indexName)

  if (ctx.pluginRegistry.hasHooks('afterInsert')) {
    const runHook = async (): Promise<void> => {
      try {
        await ctx.pluginRegistry.runHook('afterInsert', { indexName, docId: resolvedDocId, document })
      } catch (err) {
        console.warn('afterInsert plugin hook error:', err instanceof Error ? err.message : String(err))
      }
    }
    if (hold === undefined) await runHook()
    else hold.afterRelease(runHook)
  }

  return resolvedDocId
}
