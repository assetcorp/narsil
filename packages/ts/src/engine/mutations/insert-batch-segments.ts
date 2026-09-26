import { createFrozenSegment, createSharedFrozenSegment, type FrozenSegment } from '../../core/partition/frozen'
import type { PartitionManager } from '../../partitioning/manager'
import type { BatchResult } from '../../types/results'
import type { AnyDocument, InsertOptions } from '../../types/schema'
import { BATCH_CHUNK_SIZE, MIN_DOCUMENTS_FOR_SEGMENTS } from '../constants'
import type { BuiltSegment } from '../orchestration/segments'
import { insertDocumentVectors } from '../vector-coordinator'
import type { MutationContext } from './context'
import { rollbackInsertedDocument } from './durable-rollback'
import { asBatchInsertError } from './insert-admission'
import { type AdmittedInsert, admitBatchDocuments } from './insert-batch-admission'
import { applyAdmittedDocuments } from './insert-batch-documents'
import { recordChunk } from './record-batch'
import { broadcastBuiltSegments, buildSegmentRequests } from './segment-replication'
import { awaitWriteVisibility } from './write-visibility'

interface IngestOutcome {
  succeeded: string[]
  touchedVectorFields: Set<string>
}

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
      document: doc.partitionDoc,
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

interface SegmentAttachment {
  partitionId: number
  segments: FrozenSegment[]
  attached: boolean
  failure: unknown
}

function attachOnce(manager: PartitionManager, attachment: SegmentAttachment): void {
  if (attachment.failure !== undefined) throw attachment.failure
  if (attachment.attached) return
  try {
    for (const segment of attachment.segments) {
      manager.attachFrozenSegment(attachment.partitionId, segment)
    }
    attachment.attached = true
  } catch (error) {
    attachment.failure = error
    throw error
  }
}

function applyOfMergedDocument(
  ctx: MutationContext,
  indexName: string,
  doc: AdmittedInsert,
  attachment: SegmentAttachment,
  progress: { applied: boolean },
): () => Promise<void> {
  const manager = ctx.requireManager(indexName)
  return async (): Promise<void> => {
    attachOnce(manager, attachment)
    progress.applied = true
    try {
      insertDocumentVectors(
        doc.docId,
        doc.extractedVectors,
        manager.getVectorIndexes(),
        manager.partitionIdOf(doc.docId),
      )
    } catch (vecErr) {
      try {
        await ctx.executor.execute({ type: 'remove', indexName, docId: doc.docId, requestId: doc.docId })
        progress.applied = false
      } catch (rollbackErr) {
        console.warn(
          `Rollback failed for doc "${doc.docId}" during batch insert atomicity:`,
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        )
      }
      throw vecErr
    }
  }
}

interface SegmentChunk {
  docs: AdmittedInsert[]
  attachmentOf: Map<string, SegmentAttachment>
}

function chunksOfWholeSegments(
  built: BuiltSegment[],
  frozen: FrozenSegment[],
  memberIndexes: number[][],
  admitted: AdmittedInsert[],
): SegmentChunk[] {
  const chunks: SegmentChunk[] = []
  let chunk: SegmentChunk = { docs: [], attachmentOf: new Map() }
  for (let i = 0; i < built.length; i++) {
    const attachment: SegmentAttachment = {
      partitionId: built[i].partitionId,
      segments: [frozen[i]],
      attached: false,
      failure: undefined,
    }
    for (const member of memberIndexes[i]) {
      const doc = admitted[member]
      chunk.docs.push(doc)
      chunk.attachmentOf.set(doc.docId, attachment)
    }
    if (chunk.docs.length >= BATCH_CHUNK_SIZE && i + 1 < built.length) {
      chunks.push(chunk)
      chunk = { docs: [], attachmentOf: new Map() }
    }
  }
  if (chunk.docs.length > 0) chunks.push(chunk)
  return chunks
}

async function recordMergedDocuments(
  ctx: MutationContext,
  indexName: string,
  built: BuiltSegment[],
  frozen: FrozenSegment[],
  memberIndexes: number[][],
  admitted: AdmittedInsert[],
  failed: BatchResult['failed'],
): Promise<IngestOutcome & { failedDocIds: Set<string> }> {
  const hasAfterHook = ctx.pluginRegistry.hasHooks('afterInsert')
  const succeededIds = new Set<string>()
  const errorOf = new Map<string, unknown>()
  const touchedVectorFields = new Set<string>()
  const chunks = chunksOfWholeSegments(built, frozen, memberIndexes, admitted)

  for (let index = 0; index < chunks.length; index++) {
    const { docs, attachmentOf } = chunks[index]
    const progress = docs.map(() => ({ applied: false }))
    const applies = docs.map((doc, i) => {
      const attachment = attachmentOf.get(doc.docId)
      if (attachment === undefined) return async (): Promise<void> => undefined
      return applyOfMergedDocument(ctx, indexName, doc, attachment, progress[i])
    })
    const failures = await recordChunk(ctx, indexName, docs, applies)

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]
      const failure = failures[i]
      if (failure !== null) {
        let error = failure.error
        try {
          await rollbackInsertedDocument(ctx, indexName, doc.docId, progress[i].applied, error)
        } catch (rollbackError) {
          error = rollbackError
        }
        errorOf.set(doc.docId, error)
        continue
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

      succeededIds.add(doc.docId)
    }

    if (index + 1 < chunks.length) {
      ctx.checkHeapPressure(indexName)
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  const succeeded: string[] = []
  const failedDocIds = new Set<string>()
  for (const doc of admitted) {
    if (succeededIds.has(doc.docId)) {
      succeeded.push(doc.docId)
      continue
    }
    if (!errorOf.has(doc.docId)) continue
    failedDocIds.add(doc.docId)
    failed.push({ docId: doc.docId, error: asBatchInsertError(errorOf.get(doc.docId)) })
  }
  return { succeeded, touchedVectorFields, failedDocIds }
}

async function broadcastSegments(
  ctx: MutationContext,
  indexName: string,
  built: BuiltSegment[],
  memberIndexes: number[][],
  admitted: AdmittedInsert[],
  failedDocIds: Set<string>,
  options: InsertOptions | undefined,
): Promise<string[]> {
  const clean: BuiltSegment[] = []
  const retryDocs: AdmittedInsert[] = []

  for (let i = 0; i < built.length; i++) {
    const members = memberIndexes[i].map(m => admitted[m])
    if (members.some(doc => failedDocIds.has(doc.docId))) {
      retryDocs.push(...members.filter(doc => !failedDocIds.has(doc.docId)))
      continue
    }
    clean.push(built[i])
  }

  if (clean.length > 0) {
    await broadcastBuiltSegments(ctx.orchestrator, indexName, clean, options?.skipClone)
  }
  await replicateDocuments(ctx, indexName, retryDocs, options)
  return clean.map(segment => segment.segmentId)
}

function frozenSegmentOf(
  segment: BuiltSegment,
  members: AdmittedInsert[],
  options: InsertOptions | undefined,
): FrozenSegment | null {
  if (segment.snapshot !== null) return createSharedFrozenSegment(segment.snapshot)
  if (segment.payload === null) return null
  return createFrozenSegment(
    segment.payload,
    members.map(doc => mainStoreDocument(doc, options)),
    segment.segmentId,
  )
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
  const partitionDocuments = admitted.map(doc => doc.partitionDoc)
  const { requests, memberIndexes } = buildSegmentRequests(
    indexName,
    docIds,
    partitionDocuments,
    manager.partitionCount,
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
  const frozen: FrozenSegment[] = []
  for (let i = 0; i < built.length; i++) {
    const segment = frozenSegmentOf(
      built[i],
      memberIndexes[i].map(m => admitted[m]),
      options,
    )
    if (segment === null) return applyIndividually(ctx, indexName, admitted, options, failed)
    frozen.push(segment)
  }
  for (const doc of admitted) {
    if (manager.has(doc.docId)) return applyIndividually(ctx, indexName, admitted, options, failed)
  }
  const segmentIds = built.map(segment => segment.segmentId)
  ctx.orchestrator.holdUnbroadcastSegments(indexName, segmentIds)

  const recorded = await recordMergedDocuments(ctx, indexName, built, frozen, memberIndexes, admitted, failed)
  const broadcast = await broadcastSegments(
    ctx,
    indexName,
    built,
    memberIndexes,
    admitted,
    recorded.failedDocIds,
    options,
  )
  ctx.orchestrator.releaseUnbroadcastSegments(indexName, broadcast)

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
  ctx.checkHeapPressure(indexName)
  await ctx.orchestrator.scaleOutReadyIndexes()
  if (options?.wait === true) await awaitWriteVisibility(ctx, indexName)

  return { succeeded: outcome.succeeded, failed }
}
