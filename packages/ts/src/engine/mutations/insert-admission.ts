import { checkWriteMemory } from '#platform/memory-write-block'
import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import { requireDocumentWithinSizeLimit } from '../../schema/validator'
import type { AnyDocument } from '../../types/schema'
import type { PendingAdmissions } from './batch-admissions'
import type { MutationContext } from './context'

/** Resolves a document's own `id` field as its identifier when present, so a
 * caller that embeds an id in the document (the cross-language convention) keeps
 * it. Returns undefined for an absent or non-string id, leaving the caller to
 * fall back to an explicit id argument or generation. */
export function providedDocId(document: AnyDocument): string | undefined {
  if (document === null || typeof document !== 'object') return undefined
  const id = (document as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

export function requireDocumentObject(document: unknown): Promise<void> | null {
  if (document !== null && typeof document === 'object' && !Array.isArray(document)) {
    return requireDocumentWithinSizeLimit(document as Record<string, unknown>)
  }
  const received = Array.isArray(document) ? 'a list' : document === null ? 'null' : `a ${typeof document}`
  throw new NarsilError(
    ErrorCodes.DOC_VALIDATION_FAILED,
    `Each document must be an object, while this entry is ${received}`,
    {
      received,
    },
  )
}

export function requireMatchingDocId(docId: string, document: AnyDocument): void {
  const embeddedDocId = providedDocId(document)
  if (embeddedDocId === undefined || embeddedDocId === docId) return
  throw new NarsilError(
    ErrorCodes.DOC_VALIDATION_FAILED,
    `The call names document id "${docId}" while the document's own id field is "${embeddedDocId}", so the stored document would contradict the key that it is stored under`,
    { docId, documentId: embeddedDocId },
  )
}

export function capsEachPartition(ctx: MutationContext, manager: PartitionManager): boolean {
  return ctx.capacityScope === 'partition' && manager.config.partitions?.maxDocsPerPartition !== undefined
}

export function admitInsert(
  ctx: MutationContext,
  indexName: string,
  manager: PartitionManager,
  docId: string,
  pending?: PendingAdmissions,
): void {
  checkWriteMemory(ctx, indexName)
  const rebalancing = ctx.isRebalancing(indexName)
  if (rebalancing) {
    const bufferedState = ctx.bufferedDocState(indexName, docId)
    const exists = bufferedState !== undefined ? bufferedState === 'present' : manager.has(docId)
    if (exists) {
      throw new NarsilError(ErrorCodes.DOC_ALREADY_EXISTS, `Document "${docId}" already exists`, { docId })
    }
  }
  assertRoomFor(ctx, indexName, manager, docId, pending, rebalancing)
}

export function admitBufferedUpsert(
  ctx: MutationContext,
  indexName: string,
  manager: PartitionManager,
  docId: string,
): void {
  assertRoomFor(ctx, indexName, manager, docId, undefined, true)
}

function assertRoomFor(
  ctx: MutationContext,
  indexName: string,
  manager: PartitionManager,
  docId: string,
  pending: PendingAdmissions | undefined,
  rebalancing: boolean,
): void {
  if (ctx.capacityScope === 'partition') {
    if (!capsEachPartition(ctx, manager)) return
    const partitionId = manager.routePartition(docId)
    manager.assertPartitionCapacity(partitionId, pending?.byPartition.get(partitionId) ?? 0)
    return
  }
  const pendingAdmitted = pending?.total ?? 0
  if (!rebalancing) {
    manager.assertCapacity(pendingAdmitted)
    return
  }
  manager.assertCapacity(
    ctx.pendingRebalanceWrites(indexName) + pendingAdmitted,
    ctx.rebalanceTargetPartitionCount(indexName),
  )
}
