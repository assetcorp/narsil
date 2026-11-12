import {
  admitInsert,
  asBatchInsertError,
  BATCH_CHUNK_SIZE,
  createPendingAdmissions,
  ErrorCodes,
  NarsilError,
  prepareDocumentVectors,
  prepareDocumentWrites,
  providedDocId,
  recordPendingAdmission,
  requireDocumentObject,
  turnIsSpent,
  turnsAreBudgeted,
  validateDocId,
  validateDocument,
  validateDocumentStrict,
  validateVectorDimensions,
  yieldTurn,
} from '#platform/optional-writes-host'
import type { BatchResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { IndexHold } from '../index-hold'
import type { MutationContext } from './context'
import type { WritePreparation } from './write-preparation'

export interface AdmittedInsert {
  docId: string
  document: AnyDocument
  partitionDoc: AnyDocument
  extractedVectors: Map<string, Float32Array>
}

export interface InsertCandidate {
  docId: string
  document: AnyDocument
}

interface PendingInsert {
  docId: string
  preparation: WritePreparation
  refusedByHook: boolean
}

function pendingInsertOf(ctx: MutationContext, indexName: string, docId: string, document: AnyDocument): PendingInsert {
  const pending: PendingInsert = {
    docId,
    preparation: { document, beforeWrite: null, failure: undefined },
    refusedByHook: false,
  }
  if (ctx.pluginRegistry.hasHooks('beforeInsert')) {
    pending.preparation.beforeWrite = async () => {
      try {
        await ctx.pluginRegistry.runHook('beforeInsert', { indexName, docId, document })
      } catch (err) {
        pending.refusedByHook = true
        throw err
      }
    }
  }
  return pending
}

export async function prepareInsertDocuments(
  ctx: MutationContext,
  indexName: string,
  documents: AnyDocument[],
  start: number,
  end: number,
  hold: IndexHold | undefined,
  failed: BatchResult['failed'],
): Promise<{ entry: ReturnType<MutationContext['requireIndex']>; candidates: InsertCandidate[] }> {
  const pending: PendingInsert[] = []
  for (let i = start; i < end; i++) {
    if (turnsAreBudgeted && turnIsSpent()) await yieldTurn()
    if (ctx.abortController.signal.aborted) break
    const document = documents[i]
    const docId = providedDocId(document) ?? ctx.idGenerator()
    try {
      const sizing = requireDocumentObject(document)
      if (sizing !== null) await sizing
      validateDocId(docId)
      pending.push(pendingInsertOf(ctx, indexName, docId, document))
    } catch (err) {
      failed.push({ docId, error: asBatchInsertError(err) })
    }
  }
  const entry = await prepareDocumentWrites(
    ctx,
    indexName,
    pending.map(item => item.preparation),
    hold,
    true,
  )
  const candidates: InsertCandidate[] = []
  for (const item of pending) {
    const { document, failure } = item.preparation
    if (failure === undefined) {
      candidates.push({ docId: item.docId, document })
      continue
    }
    const docId = item.refusedByHook ? item.docId : (providedDocId(document) ?? '')
    failed.push({ docId, error: asBatchInsertError(failure) })
  }
  return { entry, candidates }
}

export async function admitBatchDocuments(
  ctx: MutationContext,
  indexName: string,
  documents: AnyDocument[],
  failed: BatchResult['failed'],
  hold: IndexHold | undefined,
): Promise<AdmittedInsert[]> {
  const { entry, candidates } = await prepareInsertDocuments(
    ctx,
    indexName,
    documents,
    0,
    documents.length,
    hold,
    failed,
  )
  const manager = ctx.requireManager(indexName)
  const vecIndexes = manager.getVectorIndexes()
  const vectorFieldPaths = vecIndexes.size > 0 ? entry.vectorFieldPaths : new Set<string>()
  const strict = entry.config.strict === true
  const admitted: AdmittedInsert[] = []
  const admittedIds = new Set<string>()
  const pending = createPendingAdmissions()

  for (let position = 0; position < candidates.length; position++) {
    if (position > 0 && position % BATCH_CHUNK_SIZE === 0) await new Promise<void>(r => setTimeout(r, 0))
    if (ctx.abortController.signal.aborted) break
    const { docId, document } = candidates[position]
    try {
      const { partitionDoc, extractedVectors } = prepareDocumentVectors(
        document as Record<string, unknown>,
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
      admitted.push({ docId, document, partitionDoc: partitionDoc as AnyDocument, extractedVectors })
    } catch (err) {
      failed.push({ docId, error: asBatchInsertError(err) })
    }
  }

  return admitted
}
