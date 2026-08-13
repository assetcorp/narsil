import { generateId } from '../../core/id-generator'
import { createFrozenSegment } from '../../core/partition/frozen'
import type { BatchResult } from '../../types/results'
import type { AnyDocument, InsertOptions } from '../../types/schema'
import type { BuiltSegment } from '../orchestration/segments'
import { BATCH_CHUNK_SIZE } from '../validation'
import { insertDocumentVectors } from '../vector-coordinator'
import type { MutationContext } from './context'
import { rollbackInsertedDocument } from './durable-rollback'
import { asBatchInsertError } from './insert-admission'
import { type AdmittedInsert, admitBatchDocuments } from './insert-batch-admission'
import { applyAdmittedDocuments } from './insert-batch-documents'
import { broadcastBuiltSegments, buildSegmentRequests, MIN_DOCUMENTS_FOR_SEGMENTS } from './segment-replication'

interface IngestOutcome {
  succeeded: string[]
  touchedVectorFields: Set<string>
}

function noopApply(): void {}

function mainStoreDocument(doc: AdmittedInsert, options: InsertOptions | undefined): AnyDocument {
  if (doc.extractedVectors.size > 0 || options?.skipClone === true) return doc.partitionDoc
  return structuredClone(doc.partitionDoc)
}

async function replicateDocuments(
  ctx: MutationContext,
  indexName: string,
  docs: AdmittedInsert[],
  options: InsertOptions | undefined,
): Promise<void> {
  for (const doc of docs) {
    await ctx.orchestrator.replicateToWorkers({
      type: 'insert',
      indexName,
      docId: doc.docId,
      document: doc.document,
      requestId: `replicate-insert-${doc.docId}`,
      skipClone: options?.skipClone,
    })
  }
}

async function applyIndividually(
  ctx: MutationContext,
  indexName: string,
  admitted: AdmittedInsert[],
  options: InsertOptions | undefined,
  failed: BatchResult['failed'],
): Promise<IngestOutcome> {
  const applied = await applyAdmittedDocuments(ctx, indexName, admitted, options, failed)
  const succeededIds = new Set(applied.succeeded)
  const replicable = admitted.filter(doc => succeededIds.has(doc.docId) && !applied.buffered.has(doc.docId))
  await replicateDocuments(ctx, indexName, replicable, options)
  return { succeeded: applied.succeeded, touchedVectorFields: applied.touchedVectorFields }
}

async function recordMergedDocuments(
  ctx: MutationContext,
  indexName: string,
  admitted: AdmittedInsert[],
  failed: BatchResult['failed'],
): Promise<IngestOutcome & { failedDocIds: Set<string> }> {
  const manager = ctx.requireManager(indexName)
  const vecIndexes = manager.getVectorIndexes()
  const hasAfterHook = ctx.pluginRegistry.hasHooks('afterInsert')
  const succeeded: string[] = []
  const touchedVectorFields = new Set<string>()
  const failedDocIds = new Set<string>()

  for (let i = 0; i < admitted.length; i++) {
    const doc = admitted[i]
    try {
      try {
        insertDocumentVectors(doc.docId, doc.extractedVectors, vecIndexes)
      } catch (vecErr) {
        try {
          await ctx.executor.execute({ type: 'remove', indexName, docId: doc.docId, requestId: doc.docId })
        } catch (rollbackErr) {
          console.warn(
            `Rollback failed for doc "${doc.docId}" during batch insert atomicity:`,
            rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          )
        }
        throw vecErr
      }

      if (ctx.durability) {
        try {
          await ctx.durability.recordInsertOrUpdate(indexName, doc.docId, doc.document, noopApply)
        } catch (durableErr) {
          await rollbackInsertedDocument(ctx, indexName, doc.docId, true, durableErr)
          throw durableErr
        }
      }

      for (const fieldPath of doc.extractedVectors.keys()) {
        touchedVectorFields.add(fieldPath)
      }

      if (hasAfterHook) {
        try {
          await ctx.pluginRegistry.runHook('afterInsert', { indexName, docId: doc.docId, document: doc.document })
        } catch (err) {
          console.warn('afterInsert plugin hook error:', err instanceof Error ? err.message : String(err))
        }
      }

      succeeded.push(doc.docId)
    } catch (err) {
      failedDocIds.add(doc.docId)
      failed.push({ docId: doc.docId, error: asBatchInsertError(err) })
    }

    if ((i + 1) % BATCH_CHUNK_SIZE === 0 && i + 1 < admitted.length) {
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  return { succeeded, touchedVectorFields, failedDocIds }
}

async function broadcastSegments(
  ctx: MutationContext,
  indexName: string,
  built: BuiltSegment[],
  segmentIds: string[],
  memberIndexes: number[][],
  admitted: AdmittedInsert[],
  failedDocIds: Set<string>,
  options: InsertOptions | undefined,
): Promise<void> {
  const clean: Array<{
    partitionId: number
    segmentId: string
    payload: BuiltSegment['payload']
    documents: AnyDocument[]
  }> = []
  const retryDocs: AdmittedInsert[] = []

  for (let i = 0; i < built.length; i++) {
    const members = memberIndexes[i].map(m => admitted[m])
    if (members.some(doc => failedDocIds.has(doc.docId))) {
      retryDocs.push(...members.filter(doc => !failedDocIds.has(doc.docId)))
      continue
    }
    clean.push({
      partitionId: built[i].partitionId,
      segmentId: segmentIds[i],
      payload: built[i].payload,
      documents: built[i].documents,
    })
  }

  if (clean.length > 0) {
    await broadcastBuiltSegments(ctx.orchestrator, indexName, clean, options?.skipClone)
  }
  await replicateDocuments(ctx, indexName, retryDocs, options)
}

async function ingestAdmitted(
  ctx: MutationContext,
  indexName: string,
  admitted: AdmittedInsert[],
  options: InsertOptions | undefined,
  failed: BatchResult['failed'],
): Promise<IngestOutcome> {
  if (admitted.length === 0) {
    return { succeeded: [], touchedVectorFields: new Set() }
  }

  const manager = ctx.requireManager(indexName)
  const workers = ctx.orchestrator.segmentBuildConcurrency(indexName)
  if (admitted.length < MIN_DOCUMENTS_FOR_SEGMENTS || workers <= 0) {
    return applyIndividually(ctx, indexName, admitted, options, failed)
  }

  const docIds = admitted.map(doc => doc.docId)
  const rawDocuments = admitted.map(doc => doc.document)
  const { requests, memberIndexes } = buildSegmentRequests(
    indexName,
    docIds,
    rawDocuments,
    manager.partitionCount,
    workers,
    options?.skipClone,
  )

  let built: BuiltSegment[] | null
  try {
    built = await ctx.orchestrator.buildSegments(requests)
  } catch {
    built = null
  }
  if (built === null || built.length !== requests.length) {
    return applyIndividually(ctx, indexName, admitted, options, failed)
  }

  if (ctx.isRebalancing(indexName)) {
    return applyIndividually(ctx, indexName, admitted, options, failed)
  }
  for (const doc of admitted) {
    if (manager.has(doc.docId)) {
      return applyIndividually(ctx, indexName, admitted, options, failed)
    }
  }
  const segmentIds = built.map(() => generateId())
  for (let i = 0; i < built.length; i++) {
    manager.attachFrozenSegment(
      built[i].partitionId,
      createFrozenSegment(
        built[i].payload,
        memberIndexes[i].map(m => mainStoreDocument(admitted[m], options)),
        segmentIds[i],
      ),
    )
  }

  const recorded = await recordMergedDocuments(ctx, indexName, admitted, failed)
  await broadcastSegments(ctx, indexName, built, segmentIds, memberIndexes, admitted, recorded.failedDocIds, options)

  return { succeeded: recorded.succeeded, touchedVectorFields: recorded.touchedVectorFields }
}

export async function insertBatchViaSegments(
  ctx: MutationContext,
  indexName: string,
  documents: AnyDocument[],
  options: InsertOptions | undefined,
): Promise<BatchResult> {
  const failed: BatchResult['failed'] = []
  const admitted = await admitBatchDocuments(ctx, indexName, documents, failed)
  const outcome = await ingestAdmitted(ctx, indexName, admitted, options, failed)

  const vecIndexes = ctx.requireManager(indexName).getVectorIndexes()
  for (const fieldPath of outcome.touchedVectorFields) {
    vecIndexes.get(fieldPath)?.scheduleBuild()
  }

  ctx.checkWatermark(indexName)
  await ctx.orchestrator.checkPromotion()

  return { succeeded: outcome.succeeded, failed }
}
