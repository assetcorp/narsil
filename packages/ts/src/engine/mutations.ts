import { ErrorCodes, NarsilError } from '../errors'
import type { PartitionManager } from '../partitioning/manager'
import type { WAQEntry } from '../partitioning/write-ahead-queue'
import type { FlushManager } from '../persistence/flush-manager'
import type { PluginRegistry } from '../plugins/registry'
import { validateRequiredFields } from '../schema/validator'
import type { EmbeddingAdapter } from '../types/adapters'
import type { LanguageModule } from '../types/language'
import type { BatchResult } from '../types/results'
import type { AnyDocument, EmbeddingFieldConfig, IndexConfig, InsertOptions } from '../types/schema'
import type { DirectExecutorExtensions } from '../workers/direct-executor'
import type { Executor } from '../workers/executor'
import { embedBatchDocumentFields, embedDocumentFields } from './embed'
import type { WorkerOrchestrator } from './orchestration'
import { BATCH_CHUNK_SIZE, validateDocId } from './validation'
import {
  deleteNestedValue,
  extractVectorFromDoc,
  insertDocumentVectors,
  prepareDocumentVectors,
  removeDocumentVectors,
  updateDocumentVectors,
  validateVectorDimensions,
} from './vector-coordinator'

export interface MutationContext {
  executor: Executor & DirectExecutorExtensions
  pluginRegistry: PluginRegistry
  flushManager: FlushManager | null
  orchestrator: WorkerOrchestrator
  idGenerator: () => string
  abortController: AbortController
  guardShutdown: () => void
  requireIndex: (name: string) => {
    config: IndexConfig
    language: LanguageModule
    embeddingAdapter: EmbeddingAdapter | null
    vectorFieldPaths: Set<string>
  }
  requireManager: (name: string) => PartitionManager
  bufferIfRebalancing: (name: string, entry: Omit<WAQEntry, 'sequenceNumber'>) => boolean
}

export async function insertDocument(
  ctx: MutationContext,
  indexName: string,
  document: AnyDocument,
  docId?: string,
  options?: InsertOptions,
): Promise<string> {
  ctx.guardShutdown()
  const entry = ctx.requireIndex(indexName)

  const resolvedDocId = docId ?? ctx.idGenerator()
  validateDocId(resolvedDocId)

  if (ctx.bufferIfRebalancing(indexName, { action: 'insert', docId: resolvedDocId, document, indexName })) {
    return resolvedDocId
  }

  await ctx.pluginRegistry.runHook('beforeInsert', { indexName, docId: resolvedDocId, document })

  if (entry.config.required && entry.config.required.length > 0) {
    validateRequiredFields(document as Record<string, unknown>, entry.config.required)
  }

  if (entry.embeddingAdapter && entry.config.embedding) {
    await embedDocumentFields(
      document as Record<string, unknown>,
      entry.config.embedding,
      entry.embeddingAdapter,
      ctx.abortController.signal,
    )
  }

  const insertManager = ctx.requireManager(indexName)
  const insertVecIndexes = insertManager.getVectorIndexes()

  const { partitionDoc, extractedVectors } = prepareDocumentVectors(
    document as Record<string, unknown>,
    entry.vectorFieldPaths,
    insertVecIndexes,
  )

  if (extractedVectors.size > 0) {
    validateVectorDimensions(extractedVectors, insertVecIndexes)
  }

  await ctx.executor.execute({
    type: 'insert',
    indexName,
    docId: resolvedDocId,
    document: partitionDoc as AnyDocument,
    requestId: resolvedDocId,
    skipClone: extractedVectors.size > 0 ? true : options?.skipClone,
  })

  try {
    insertDocumentVectors(resolvedDocId, extractedVectors, insertVecIndexes)
  } catch (err) {
    try {
      await ctx.executor.execute({ type: 'remove', indexName, docId: resolvedDocId, requestId: resolvedDocId })
    } catch (rollbackErr) {
      console.warn(
        `Rollback failed for doc "${resolvedDocId}" during insert atomicity:`,
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
      )
    }
    throw err
  }

  try {
    await ctx.pluginRegistry.runHook('afterInsert', { indexName, docId: resolvedDocId, document })
  } catch (err) {
    console.warn('afterInsert plugin hook error:', err instanceof Error ? err.message : String(err))
  }

  ctx.flushManager?.markDirty(indexName, 0)

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

  await ctx.orchestrator.checkPromotion()

  return resolvedDocId
}

export async function insertDocumentBatch(
  ctx: MutationContext,
  indexName: string,
  documents: AnyDocument[],
  options?: InsertOptions,
): Promise<BatchResult> {
  ctx.guardShutdown()
  const entry = ctx.requireIndex(indexName)

  const succeeded: string[] = []
  const succeededDocs: AnyDocument[] = []
  const failed: BatchResult['failed'] = []
  const hasBeforeHook = ctx.pluginRegistry.hasHooks('beforeInsert')
  const hasAfterHook = ctx.pluginRegistry.hasHooks('afterInsert')
  const hasRequired = entry.config.required && entry.config.required.length > 0
  const hasEmbedding = entry.embeddingAdapter && entry.config.embedding

  const batchManager = ctx.requireManager(indexName)
  const batchVecIndexes = batchManager.getVectorIndexes()
  const batchVectorFieldPaths = batchVecIndexes.size > 0 ? entry.vectorFieldPaths : new Set<string>()
  const touchedVectorFields = new Set<string>()

  for (let chunkStart = 0; chunkStart < documents.length; chunkStart += BATCH_CHUNK_SIZE) {
    if (ctx.abortController.signal.aborted) break

    const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, documents.length)
    const chunkFailedIndexes = new Set<number>()

    if (hasRequired) {
      for (let i = chunkStart; i < chunkEnd; i++) {
        try {
          validateRequiredFields(documents[i] as Record<string, unknown>, entry.config.required as string[])
        } catch (err) {
          chunkFailedIndexes.add(i)
          failed.push({
            docId: '',
            error: err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, String(err)),
          })
        }
      }
    }

    if (hasEmbedding) {
      const embeddableSlice: Record<string, unknown>[] = []
      const embeddableOriginalIndexes: number[] = []
      for (let i = chunkStart; i < chunkEnd; i++) {
        if (chunkFailedIndexes.has(i)) continue
        embeddableSlice.push(documents[i] as Record<string, unknown>)
        embeddableOriginalIndexes.push(i)
      }

      if (embeddableSlice.length > 0) {
        try {
          const embedResult = await embedBatchDocumentFields(
            embeddableSlice,
            entry.config.embedding as EmbeddingFieldConfig,
            entry.embeddingAdapter as EmbeddingAdapter,
            ctx.abortController.signal,
          )

          for (const [sliceIndex, error] of embedResult.failed) {
            const originalIdx = embeddableOriginalIndexes[sliceIndex]
            chunkFailedIndexes.add(originalIdx)
            failed.push({ docId: '', error })
          }
        } catch (err) {
          const embeddingError =
            err instanceof NarsilError ? err : new NarsilError(ErrorCodes.EMBEDDING_FAILED, String(err))
          for (const originalIdx of embeddableOriginalIndexes) {
            chunkFailedIndexes.add(originalIdx)
            failed.push({ docId: '', error: embeddingError })
          }
        }
      }
    }

    for (let i = chunkStart; i < chunkEnd; i++) {
      if (ctx.abortController.signal.aborted) break
      if (chunkFailedIndexes.has(i)) continue

      const batchDocId = ctx.idGenerator()
      try {
        validateDocId(batchDocId)

        if (hasBeforeHook) {
          await ctx.pluginRegistry.runHook('beforeInsert', { indexName, docId: batchDocId, document: documents[i] })
        }

        const { partitionDoc, extractedVectors } = prepareDocumentVectors(
          documents[i] as Record<string, unknown>,
          batchVectorFieldPaths,
          batchVecIndexes,
        )

        if (extractedVectors.size > 0) {
          validateVectorDimensions(extractedVectors, batchVecIndexes)
        }

        const result = ctx.executor.execute({
          type: 'insert',
          indexName,
          docId: batchDocId,
          document: partitionDoc as AnyDocument,
          requestId: batchDocId,
          skipClone: extractedVectors.size > 0 ? true : options?.skipClone,
        })
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          await result
        }

        try {
          insertDocumentVectors(batchDocId, extractedVectors, batchVecIndexes)
        } catch (vecErr) {
          try {
            await ctx.executor.execute({ type: 'remove', indexName, docId: batchDocId, requestId: batchDocId })
          } catch (rollbackErr) {
            console.warn(
              `Rollback failed for doc "${batchDocId}" during batch insert atomicity:`,
              rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            )
          }
          throw vecErr
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
        failed.push({
          docId: batchDocId,
          error: err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, String(err)),
        })
      }
    }

    if (chunkEnd < documents.length) {
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  ctx.flushManager?.markDirty(indexName, 0)

  for (let i = 0; i < succeeded.length; i++) {
    await ctx.orchestrator.replicateToWorkers({
      type: 'insert',
      indexName,
      docId: succeeded[i],
      document: succeededDocs[i],
      requestId: `replicate-insert-${succeeded[i]}`,
      skipClone: options?.skipClone,
    })
  }

  for (const fieldPath of touchedVectorFields) {
    const vecIndex = batchVecIndexes.get(fieldPath)
    if (vecIndex) {
      vecIndex.scheduleBuild()
    }
  }

  await ctx.orchestrator.checkPromotion()

  return { succeeded, failed }
}

export async function removeDocument(ctx: MutationContext, indexName: string, docId: string): Promise<void> {
  ctx.guardShutdown()
  ctx.requireIndex(indexName)
  validateDocId(docId)

  if (ctx.bufferIfRebalancing(indexName, { action: 'remove', docId, indexName })) {
    return
  }

  await ctx.pluginRegistry.runHook('beforeRemove', { indexName, docId })

  await ctx.executor.execute({ type: 'remove', indexName, docId, requestId: docId })

  const removeManager = ctx.requireManager(indexName)
  const removeVecIndexes = removeManager.getVectorIndexes()
  removeDocumentVectors(docId, removeVecIndexes)

  try {
    await ctx.pluginRegistry.runHook('afterRemove', { indexName, docId })
  } catch (err) {
    console.warn('afterRemove plugin hook error:', err instanceof Error ? err.message : String(err))
  }

  ctx.flushManager?.markDirty(indexName, 0)

  await ctx.orchestrator.replicateToWorkers({
    type: 'remove',
    indexName,
    docId,
    requestId: `replicate-remove-${docId}`,
  })
}

export async function removeDocumentBatch(
  ctx: MutationContext,
  indexName: string,
  docIds: string[],
): Promise<BatchResult> {
  ctx.guardShutdown()
  ctx.requireIndex(indexName)

  const succeeded: string[] = []
  const failed: BatchResult['failed'] = []
  const manager = ctx.requireManager(indexName)
  manager.beginBatchRemove()

  try {
    for (let chunkStart = 0; chunkStart < docIds.length; chunkStart += BATCH_CHUNK_SIZE) {
      const chunkEnd = Math.min(chunkStart + BATCH_CHUNK_SIZE, docIds.length)

      for (let i = chunkStart; i < chunkEnd; i++) {
        try {
          await removeDocument(ctx, indexName, docIds[i])
          succeeded.push(docIds[i])
        } catch (err) {
          failed.push({
            docId: docIds[i],
            error: err instanceof NarsilError ? err : new NarsilError(ErrorCodes.DOC_NOT_FOUND, String(err)),
          })
        }
      }

      if (chunkEnd < docIds.length) {
        await new Promise<void>(r => setTimeout(r, 0))
      }
    }
  } finally {
    manager.endBatchRemove()
  }

  return { succeeded, failed }
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
