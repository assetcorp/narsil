import type { FrozenSegment } from '../../core/partition/frozen'
import { ErrorCodes, NarsilError } from '../../errors'

export function requireNewSegmentDocuments(segment: FrozenSegment, docPartitionMap: ReadonlyMap<string, number>): void {
  for (const internalId of segment.docStore.allInternalIds()) {
    const docId = segment.docStore.getExternalId(internalId)
    if (docId === undefined || !docPartitionMap.has(docId)) continue
    throw new NarsilError(ErrorCodes.DOC_ALREADY_EXISTS, `Document "${docId}" already exists`, {
      docId,
      partitionId: docPartitionMap.get(docId),
    })
  }
}
