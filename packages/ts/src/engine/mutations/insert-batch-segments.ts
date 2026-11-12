import {
  BATCH_CHUNK_SIZE,
  createFrozenSegment,
  createSharedFrozenSegment,
  MIN_DOCUMENTS_FOR_SEGMENTS,
} from '#platform/optional-writes-host'
import type { FrozenSegment } from '../../core/partition/frozen'
import type { BatchResult } from '../../types/results'
import type { AnyDocument, InsertOptions } from '../../types/schema'
import type { IndexHold } from '../index-hold'
import type { BuiltSegment } from '../orchestration/segments'
import { asBatchInsertError } from './batch-admissions'
import type { MutationContext } from './context'
import { rollbackInsertedDocument } from './durable-rollback'
import { type AdmittedInsert, admitBatchDocuments } from './insert-batch-admission'
import { finishInsertBatch, insertInChunks } from './insert-batch-chunks'
import { applyAdmittedDocuments, runAfterInsertHooks } from './insert-batch-documents'
import { recordChunk } from './record-batch'
import { applySegment, type SegmentAttachment } from './segment-publication'
import { buildSegmentRequests } from './segment-replication'

interface IngestOutcome {
  succeeded: string[]
  touchedVectorFields: Set<string>
  unrecorded: AdmittedInsert[]
}

function mainStoreDocument(doc: AdmittedInsert, options: InsertOptions | undefined): AnyDocument {
  if (doc.extractedVectors.size > 0 || options?.skipClone === true) return doc.partitionDoc
  return structuredClone(doc.partitionDoc)
}

interface SegmentChunk {
  docs: AdmittedInsert[]
  attachmentOf: Map<string, SegmentAttachment>
}

function chunksOfWholeSegments(
  indexName: string,
  partitionCount: number,
  built: BuiltSegment[],
  frozen: FrozenSegment[],
  memberIndexes: number[][],
  admitted: AdmittedInsert[],
): SegmentChunk[] {
  const chunks: SegmentChunk[] = []
  let chunk: SegmentChunk = { docs: [], attachmentOf: new Map() }
  for (let i = 0; i < built.length; i++) {
    const builtSegment = built[i]
    const requestId = `attach-${builtSegment.segmentId}`
    const action =
      builtSegment.snapshot !== null
        ? {
            type: 'attachSegments' as const,
            indexName,
            requestId,
            segments: [{ partitionId: builtSegment.partitionId, snapshot: builtSegment.snapshot }],
          }
        : {
            type: 'mergeSegments' as const,
            indexName,
            requestId,
            segments:
              builtSegment.payload === null
                ? []
                : [
                    {
                      partitionId: builtSegment.partitionId,
                      payload: builtSegment.payload,
                      documents: builtSegment.documents,
                    },
                  ],
          }
    const attachment: SegmentAttachment = {
      partitionId: built[i].partitionId,
      partitionCount,
      segment: frozen[i],
      members: memberIndexes[i].map(member => admitted[member]),
      applied: new Set(),
      rollback: new Map(),
      buffered: new Set(),
      individual: false,
      attached: false,
      failure: undefined,
      action,
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
  partitionCount: number,
  built: BuiltSegment[],
  frozen: FrozenSegment[],
  memberIndexes: number[][],
  admitted: AdmittedInsert[],
  options: InsertOptions | undefined,
  hold: IndexHold | undefined,
  failed: BatchResult['failed'],
): Promise<IngestOutcome> {
  const succeededIds = new Set<string>()
  const errorOf = new Map<string, unknown>()
  const touchedVectorFields = new Set<string>()
  const chunks = chunksOfWholeSegments(indexName, partitionCount, built, frozen, memberIndexes, admitted)
  const unrecorded: AdmittedInsert[] = []

  for (let index = 0; index < chunks.length; index++) {
    const { docs, attachmentOf } = chunks[index]
    const applies = docs.map(doc => {
      const attachment = attachmentOf.get(doc.docId)
      if (attachment === undefined) return async (): Promise<void> => undefined
      return applySegment(ctx, indexName, attachment, doc, options)
    })
    const failures = await recordChunk(ctx, indexName, docs, applies)
    await ctx.orchestrator.settlePublications(indexName, 'segments')
    const inserted: AdmittedInsert[] = []

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]
      const failure = failures[i]
      if (failure !== null) {
        let error = failure.error
        const attachment = attachmentOf.get(doc.docId)
        const rollback = attachment?.rollback.get(doc.docId)
        try {
          await rollbackInsertedDocument(
            ctx,
            indexName,
            doc.docId,
            attachment?.applied.has(doc.docId) === true,
            error,
            rollback?.preparedText,
            rollback?.appliedRef,
            rollback?.removedSpellings,
          )
        } catch (rollbackError) {
          error = rollbackError
        }
        errorOf.set(doc.docId, error)
        continue
      }

      if (attachmentOf.get(doc.docId)?.buffered.has(doc.docId) === true) {
        succeededIds.add(doc.docId)
        continue
      }
      for (const fieldPath of doc.extractedVectors.keys()) {
        touchedVectorFields.add(fieldPath)
      }
      inserted.push(doc)
      succeededIds.add(doc.docId)
    }

    if (await runAfterInsertHooks(ctx, indexName, inserted, hold)) {
      for (const later of chunks.slice(index + 1)) unrecorded.push(...later.docs)
      break
    }
    if (index + 1 < chunks.length) {
      ctx.checkHeapPressure(indexName)
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  const succeeded: string[] = []
  for (const doc of admitted) {
    if (succeededIds.has(doc.docId)) {
      succeeded.push(doc.docId)
      continue
    }
    if (!errorOf.has(doc.docId)) continue
    failed.push({ docId: doc.docId, error: asBatchInsertError(errorOf.get(doc.docId)) })
  }
  return { succeeded, touchedVectorFields, unrecorded }
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
  hold: IndexHold | undefined,
  failed: BatchResult['failed'],
): Promise<IngestOutcome> {
  if (admitted.length === 0) {
    return { succeeded: [], touchedVectorFields: new Set(), unrecorded: [] }
  }

  const applyIndividually = (): Promise<IngestOutcome> =>
    applyAdmittedDocuments(ctx, indexName, admitted, options, hold, failed)
  const manager = ctx.requireManager(indexName)
  const workers = ctx.orchestrator.segmentBuildConcurrency(indexName)
  if (admitted.length < MIN_DOCUMENTS_FOR_SEGMENTS || workers <= 0) {
    return applyIndividually()
  }

  const docIds = admitted.map(doc => doc.docId)
  const partitionDocuments = admitted.map(doc => doc.partitionDoc)
  const partitionCount = manager.partitionCount
  const { requests } = buildSegmentRequests(indexName, docIds, partitionDocuments, partitionCount, options?.skipClone)

  let built: BuiltSegment[] | null
  try {
    built = await ctx.orchestrator.buildSegments(requests)
  } catch {
    built = null
  }
  if (built === null) {
    return applyIndividually()
  }
  const positions = new Map(admitted.map((document, index) => [document.docId, index]))
  const used = new Set<number>()
  const memberIndexes: number[][] = []
  for (const segment of built) {
    const members: number[] = []
    for (const docId of segment.docIds) {
      const position = positions.get(docId)
      if (position === undefined || used.has(position)) return applyIndividually()
      used.add(position)
      members.push(position)
    }
    memberIndexes.push(members)
  }
  if (used.size !== admitted.length) return applyIndividually()

  if (ctx.isRebalancing(indexName)) {
    return applyIndividually()
  }
  const frozen: FrozenSegment[] = []
  for (let i = 0; i < built.length; i++) {
    const segment = frozenSegmentOf(
      built[i],
      memberIndexes[i].map(m => admitted[m]),
      options,
    )
    if (segment === null) return applyIndividually()
    frozen.push(segment)
  }
  for (const doc of admitted) {
    if (manager.has(doc.docId)) return applyIndividually()
  }
  return recordMergedDocuments(
    ctx,
    indexName,
    partitionCount,
    built,
    frozen,
    memberIndexes,
    admitted,
    options,
    hold,
    failed,
  )
}

export async function insertBatchViaSegments(
  ctx: MutationContext,
  indexName: string,
  documents: AnyDocument[],
  options: InsertOptions | undefined,
  hold: IndexHold | undefined,
): Promise<BatchResult> {
  const failed: BatchResult['failed'] = []
  const admitted = await admitBatchDocuments(ctx, indexName, documents, failed, hold)
  const outcome = await ingestAdmitted(ctx, indexName, admitted, options, hold, failed)
  if (outcome.unrecorded.length > 0) {
    const unrecorded = outcome.unrecorded.map(doc => doc.document)
    const rest = await insertInChunks(ctx, indexName, unrecorded, options, hold, false, failed)
    outcome.succeeded.push(...rest.succeeded)
    for (const fieldPath of rest.touchedVectorFields) outcome.touchedVectorFields.add(fieldPath)
  }
  await finishInsertBatch(ctx, indexName, outcome, options)

  return { succeeded: outcome.succeeded, failed }
}
