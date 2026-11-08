import {
  admitInsert,
  asBatchInsertError,
  BATCH_CHUNK_SIZE,
  collectRequiredFieldFailures,
  createPendingAdmissions,
  ErrorCodes,
  embedChunkDocuments,
  NarsilError,
  prepareDocumentVectors,
  providedDocId,
  recordPendingAdmission,
  requireDocumentObject,
  validateDocId,
  validateDocument,
  validateDocumentStrict,
  validateVectorDimensions,
} from '#platform/optional-writes-host'
import type { BatchResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { MutationContext } from './context'

export interface AdmittedInsert {
  docId: string
  document: AnyDocument
  partitionDoc: AnyDocument
  extractedVectors: Map<string, Float32Array>
}

export async function admitBatchDocuments(
  ctx: MutationContext,
  indexName: string,
  documents: AnyDocument[],
  failed: BatchResult['failed'],
): Promise<AdmittedInsert[]> {
  const entry = ctx.requireIndex(indexName)
  const manager = ctx.requireManager(indexName)
  const vecIndexes = manager.getVectorIndexes()
  const vectorFieldPaths = vecIndexes.size > 0 ? entry.vectorFieldPaths : new Set<string>()
  const hasBeforeHook = ctx.pluginRegistry.hasHooks('beforeInsert')
  const strict = entry.config.strict === true
  const required = entry.config.required
  const admitted: AdmittedInsert[] = []
  const admittedIds = new Set<string>()
  const pending = createPendingAdmissions()

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

      const docId = providedDocId(documents[i]) ?? ctx.idGenerator()
      try {
        const sizing = requireDocumentObject(documents[i])
        if (sizing !== null) await sizing
        validateDocId(docId)

        if (hasBeforeHook) {
          await ctx.pluginRegistry.runHook('beforeInsert', { indexName, docId, document: documents[i] })
        }

        const { partitionDoc, extractedVectors } = prepareDocumentVectors(
          documents[i] as Record<string, unknown>,
          vectorFieldPaths,
        )
        if (extractedVectors.size > 0) {
          validateVectorDimensions(extractedVectors, vecIndexes)
        }

        admitInsert(ctx, indexName, manager, docId, pending)
        if (admittedIds.has(docId) || manager.has(docId)) {
          throw new NarsilError(ErrorCodes.DOC_ALREADY_EXISTS, `Document "${docId}" already exists`, { docId })
        }

        validateDocument(partitionDoc as AnyDocument, entry.config.schema, entry.config.patternValueLimit)
        if (strict) {
          validateDocumentStrict(partitionDoc, entry.config.schema)
        }

        admittedIds.add(docId)
        recordPendingAdmission(ctx, pending, manager, docId)
        admitted.push({ docId, document: documents[i], partitionDoc: partitionDoc as AnyDocument, extractedVectors })
      } catch (err) {
        failed.push({ docId, error: asBatchInsertError(err) })
      }
    }

    if (chunkEnd < documents.length) {
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  return admitted
}
