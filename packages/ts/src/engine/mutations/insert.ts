import { validateRequiredFields } from '../../schema/validator'
import type { AnyDocument, InsertOptions } from '../../types/schema'
import { assertDocumentCarriesMappedVectors, embedDocumentFields } from '../embed'
import { validateDocId } from '../validation'
import { insertDocumentVectors, prepareDocumentVectors, validateVectorDimensions } from '../vector-coordinator'
import type { MutationContext } from './context'
import { rollbackInsertedDocument } from './durable-rollback'
import { admitInsert, providedDocId } from './insert-admission'

export async function insertDocument(
  ctx: MutationContext,
  indexName: string,
  document: AnyDocument,
  docId?: string,
  options?: InsertOptions,
): Promise<string> {
  ctx.guardShutdown()
  const entry = ctx.requireIndex(indexName)

  const resolvedDocId = docId ?? providedDocId(document) ?? ctx.idGenerator()
  validateDocId(resolvedDocId)

  await ctx.pluginRegistry.runHook('beforeInsert', { indexName, docId: resolvedDocId, document })

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
  const applyInsert = async (): Promise<void> => {
    admitInsert(ctx, indexName, insertManager, resolvedDocId)
    if (ctx.bufferIfRebalancing(indexName, { action: 'insert', docId: resolvedDocId, document, indexName })) {
      buffered = true
      return
    }
    await ctx.executor.execute({
      type: 'insert',
      indexName,
      docId: resolvedDocId,
      document: partitionDoc as AnyDocument,
      requestId: resolvedDocId,
      skipClone: extractedVectors.size > 0 ? true : options?.skipClone,
    })
    inserted = true
    try {
      insertDocumentVectors(resolvedDocId, extractedVectors, insertVecIndexes)
    } catch (err) {
      try {
        await ctx.executor.execute({ type: 'remove', indexName, docId: resolvedDocId, requestId: resolvedDocId })
        inserted = false
      } catch (rollbackErr) {
        console.warn(
          `Rollback failed for doc "${resolvedDocId}" during insert atomicity:`,
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        )
      }
      throw err
    }
  }

  if (ctx.durability) {
    try {
      await ctx.durability.recordInsertOrUpdate(indexName, resolvedDocId, document, applyInsert)
    } catch (err) {
      await rollbackInsertedDocument(ctx, indexName, resolvedDocId, inserted, err)
      throw err
    }
  } else {
    await applyInsert()
  }

  if (buffered) {
    ctx.checkWatermark(indexName)
    return resolvedDocId
  }

  try {
    await ctx.pluginRegistry.runHook('afterInsert', { indexName, docId: resolvedDocId, document })
  } catch (err) {
    console.warn('afterInsert plugin hook error:', err instanceof Error ? err.message : String(err))
  }

  await ctx.orchestrator.replicateToWorkers({
    type: 'insert',
    indexName,
    docId: resolvedDocId,
    document,
    requestId: `replicate-insert-${resolvedDocId}`,
    skipClone: options?.skipClone,
  })

  for (const fieldPath of extractedVectors.keys()) {
    const vecIndex = insertVecIndexes.get(fieldPath)
    if (vecIndex) {
      vecIndex.scheduleBuild()
    }
  }

  ctx.checkWatermark(indexName)
  await ctx.orchestrator.checkPromotion()

  return resolvedDocId
}
