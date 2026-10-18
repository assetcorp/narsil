import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import type { PartialWordAnalysis } from '../partial-words/spellings'
import { encodeSegmentState } from '../segment-payload'
import type { FrozenSegment } from './index'
import { freezeSegmentShared, type SharedSegmentSnapshot } from './shared-snapshot'

export interface SharedFrozenSegment {
  snapshot: SharedSegmentSnapshot
  tombstonedDocIds: string[]
}

export function shareFrozenSegment(
  segment: FrozenSegment,
  analysis: PartialWordAnalysis | null,
): SharedFrozenSegment | null {
  if (segment.sharedSnapshot !== null) {
    return { snapshot: segment.sharedSnapshot, tombstonedDocIds: segment.tombstonedDocIds() }
  }
  const payload = encodeSegmentState(segment)
  const documents: AnyDocument[] = payload.docIds.map(docId => {
    const stored = segment.docStore.get(docId)
    if (stored === undefined) {
      throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, `Document "${docId}" vanished while sharing a segment`, {
        docId,
      })
    }
    return stored.fields as AnyDocument
  })
  const snapshot = freezeSegmentShared(payload, documents, segment.segmentId, analysis)
  return snapshot === null ? null : { snapshot, tombstonedDocIds: [] }
}
