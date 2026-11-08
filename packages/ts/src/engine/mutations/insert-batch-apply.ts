import { indexChangeOutsideExternalWaits } from '#platform/turn-budget'
import type { PreparedTextChange } from '../../core/partition/prepared-text'
import type { AnyDocument, InsertOptions } from '../../types/schema'
import { insertDocumentVectors } from '../vector-coordinator'
import type { ApplyMutation, MutationContext } from './context'
import { rollbackInsertedDocument } from './durable-rollback'
import { admitInsert } from './insert-admission'
import type { AdmittedInsert } from './insert-batch-admission'
import { recordChunk } from './record-batch'

export type InsertApplication =
  | { status: 'inserted' }
  | { status: 'buffered' }
  | { status: 'skipped' }
  | { status: 'failed'; error: unknown }

export interface InsertProgress {
  appliedRef?: AnyDocument
  preparedText?: PreparedTextChange
  inserted: boolean
  buffered: boolean
  skipped: boolean
}

export function applyInsertDocument(
  ctx: MutationContext,
  indexName: string,
  doc: AdmittedInsert,
  options: InsertOptions | undefined,
  progress: InsertProgress,
): ApplyMutation {
  const manager = ctx.requireManager(indexName)
  const insertIntoIndex = () => {
    if (ctx.abortController.signal.aborted) {
      progress.skipped = true
      throw ctx.abortController.signal.reason
    }
    admitInsert(ctx, indexName, manager, doc.docId)
    const queued = ctx.bufferIfRebalancing(indexName, {
      action: 'insert',
      docId: doc.docId,
      document: doc.document,
      indexName,
    })
    if (queued !== undefined) {
      progress.buffered = true
      return queued
    }
    manager.insert(doc.docId, doc.partitionDoc, {
      skipClone: doc.extractedVectors.size > 0 ? true : options?.skipClone,
      onPreparedText:
        doc.extractedVectors.size > 0 || ctx.durability !== null
          ? change => {
              progress.preparedText = change
            }
          : undefined,
    })
    progress.inserted = true
    try {
      insertDocumentVectors(
        doc.docId,
        doc.extractedVectors,
        manager.getVectorIndexes(),
        manager.partitionIdOf(doc.docId),
      )
    } catch (vecErr) {
      try {
        manager.remove(doc.docId, undefined, { preparedText: { before: progress.preparedText?.after } })
        progress.inserted = false
      } catch (rollbackErr) {
        console.warn(
          `Rollback failed for doc "${doc.docId}" during batch insert atomicity:`,
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        )
      }
      throw vecErr
    }
    if (ctx.durability === null) progress.preparedText = undefined
    else progress.appliedRef = manager.getRef(doc.docId)
    ctx.orchestrator.publishToWorkers({
      type: 'insert',
      indexName,
      docId: doc.docId,
      document: doc.partitionDoc,
      requestId: `replicate-insert-${doc.docId}`,
      skipClone: options?.skipClone,
    })
  }
  return () => manager.publication.write(indexChangeOutsideExternalWaits(insertIntoIndex))
}

export async function applyInsertChunk(
  ctx: MutationContext,
  indexName: string,
  docs: readonly AdmittedInsert[],
  options: InsertOptions | undefined,
): Promise<InsertApplication[]> {
  const progress: InsertProgress[] = docs.map(() => ({ inserted: false, buffered: false, skipped: false }))
  const applies = docs.map((doc, i) => applyInsertDocument(ctx, indexName, doc, options, progress[i]))
  const failures = await recordChunk(ctx, indexName, docs, applies)
  await ctx.orchestrator.settlePublications(indexName)

  const applications: InsertApplication[] = []
  for (let i = 0; i < docs.length; i++) {
    if (progress[i].skipped) {
      applications.push({ status: 'skipped' })
      continue
    }
    const failure = failures[i]
    if (failure !== null) {
      let error = failure.error
      if (ctx.durability) {
        try {
          await rollbackInsertedDocument(
            ctx,
            indexName,
            docs[i].docId,
            progress[i].inserted,
            error,
            progress[i].preparedText,
            progress[i].appliedRef,
          )
        } catch (rollbackError) {
          error = rollbackError
        }
      }
      applications.push({ status: 'failed', error })
      continue
    }
    applications.push({ status: progress[i].buffered ? 'buffered' : 'inserted' })
  }
  return applications
}
