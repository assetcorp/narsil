import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import type { AnyDocument } from '../../types/schema'
import type { MutationContext } from './context'

/** Resolves a document's own `id` field as its identifier when present, so a
 * caller that embeds an id in the document (the cross-language convention) keeps
 * it. Returns undefined for an absent or non-string id, leaving the caller to
 * fall back to an explicit id argument or generation. */
export function providedDocId(document: AnyDocument): string | undefined {
  const id = (document as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

export function admitInsert(ctx: MutationContext, indexName: string, manager: PartitionManager, docId: string): void {
  if (!ctx.isRebalancing(indexName)) {
    manager.assertCapacity()
    return
  }
  const bufferedState = ctx.bufferedDocState(indexName, docId)
  const exists = bufferedState !== undefined ? bufferedState === 'present' : manager.has(docId)
  if (exists) {
    throw new NarsilError(ErrorCodes.DOC_ALREADY_EXISTS, `Document "${docId}" already exists`, { docId })
  }
  manager.assertCapacity(ctx.pendingRebalanceWrites(indexName), ctx.rebalanceTargetPartitionCount(indexName))
}
