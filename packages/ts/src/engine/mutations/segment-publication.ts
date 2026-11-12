import {
  admitInsert,
  ErrorCodes,
  indexChangeOutsideExternalWaits,
  insertDocumentVectors,
  NarsilError,
  removeDocumentVectors,
} from '#platform/optional-writes-host'
import type { FrozenSegment } from '../../core/partition/frozen'
import type { RemovedSpellings } from '../../core/partition/frozen/surface-slot'
import type { InsertOptions } from '../../types/schema'
import type { WorkerAction } from '../../workers/protocol'
import { createPendingAdmissions, recordPendingAdmission } from './batch-admissions'
import type { ApplyMutation, MutationContext } from './context'
import type { AdmittedInsert } from './insert-batch-admission'
import { applyInsertDocument, type InsertProgress } from './insert-batch-apply'

export interface SegmentAttachment {
  partitionId: number
  partitionCount: number
  segment: FrozenSegment
  members: AdmittedInsert[]
  applied: Set<string>
  rollback: Map<string, InsertProgress & { removedSpellings?: RemovedSpellings }>
  buffered: Set<string>
  individual: boolean
  attached: boolean
  failure: unknown
  action: WorkerAction
}

export function applySegment(
  ctx: MutationContext,
  indexName: string,
  attachment: SegmentAttachment,
  doc: AdmittedInsert,
  options: InsertOptions | undefined,
): ApplyMutation {
  const manager = ctx.requireManager(indexName)
  const publish = async (): Promise<void> => {
    if (attachment.failure !== undefined) throw attachment.failure
    if (attachment.attached) return
    if (ctx.abortController.signal.aborted) throw ctx.abortController.signal.reason
    if (ctx.isRebalancing(indexName) || manager.partitionCount !== attachment.partitionCount) {
      attachment.individual = true
    }
    if (attachment.individual) return
    const inserted: string[] = []
    const vectors = manager.getVectorIndexes()
    try {
      const pending = createPendingAdmissions()
      for (const doc of attachment.members) {
        if (manager.has(doc.docId)) {
          throw new NarsilError(ErrorCodes.DOC_ALREADY_EXISTS, `Document "${doc.docId}" already exists`)
        }
        admitInsert(ctx, indexName, manager, doc.docId, pending)
        recordPendingAdmission(ctx, pending, manager, doc.docId)
      }
      if (ctx.durability !== null) {
        attachment.segment.removals.bind(manager.textAnalysis)
        for (const doc of attachment.members) {
          attachment.rollback.set(doc.docId, {
            inserted: true,
            buffered: false,
            skipped: false,
            removedSpellings: attachment.segment.removedSpellingsOf(doc.docId),
          })
        }
      }
      for (const doc of attachment.members) {
        insertDocumentVectors(doc.docId, doc.extractedVectors, vectors, attachment.partitionId)
        inserted.push(doc.docId)
      }
      manager.attachFrozenSegment(attachment.partitionId, attachment.segment)
      attachment.attached = true
      for (const doc of attachment.members) attachment.applied.add(doc.docId)
      ctx.orchestrator.publishToWorkers(attachment.action)
    } catch (error) {
      for (const docId of inserted) removeDocumentVectors(docId, vectors)
      attachment.failure = error
      throw error
    }
  }
  return async () => {
    await manager.publication.write(indexChangeOutsideExternalWaits(publish))
    if (!attachment.individual) return
    const progress: InsertProgress = { inserted: false, buffered: false, skipped: false }
    attachment.rollback.set(doc.docId, progress)
    try {
      return (await applyInsertDocument(ctx, indexName, doc, options, progress)()) ?? undefined
    } finally {
      if (progress.inserted) attachment.applied.add(doc.docId)
      if (progress.buffered) attachment.buffered.add(doc.docId)
    }
  }
}
