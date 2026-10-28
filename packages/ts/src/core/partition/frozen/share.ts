import { ErrorCodes, NarsilError } from '../../../errors'
import type { SerializedSurfaceForms } from '../../../types/internal'
import type { AnyDocument } from '../../../types/schema'
import type { PartialWordAnalysis } from '../partial-words/spellings'
import { encodeSegmentState } from '../segment-payload'
import type { FrozenSegment } from './index'
import { freezeSegmentShared, type SharedSegmentSnapshot } from './shared-snapshot'

export interface SharedFrozenSegment {
  snapshot: SharedSegmentSnapshot
  tombstonedDocIds: string[]
  survivingSurfaceForms?: SerializedSurfaceForms
}

export function shareFrozenSegment(
  segment: FrozenSegment,
  analysis: PartialWordAnalysis | null,
): SharedFrozenSegment | null {
  if (segment.sharedSnapshot !== null) {
    const tombstonedDocIds = segment.tombstonedDocIds()
    if (tombstonedDocIds.length === 0 || !segment.removals.settled) {
      return { snapshot: segment.sharedSnapshot, tombstonedDocIds }
    }
    return {
      snapshot: segment.sharedSnapshot,
      tombstonedDocIds,
      survivingSurfaceForms: segment.surfaces.reader.serialize(),
    }
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
