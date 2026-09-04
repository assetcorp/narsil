import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import { encodeSegmentState } from '../segment-payload'
import type { FrozenSegment } from './index'
import { freezeSegmentShared, type SharedSegmentSnapshot } from './shared-snapshot'

export interface SharedFrozenSegment {
  snapshot: SharedSegmentSnapshot
  tombstonedDocIds: string[]
}

/**
 * Produces the shared-memory form of a frozen segment so that a worker can
 * attach the same documents.
 *
 * For a segment that came from shared memory this returns the snapshot the
 * segment already wraps, together with the documents removed since, so the
 * call copies no bytes. For a segment built on the heap this encodes the
 * surviving documents once into shared memory.
 *
 * @param segment - The frozen segment to share.
 * @returns The snapshot and the removed document ids, or null where the
 * runtime offers no shared memory.
 */
export function shareFrozenSegment(segment: FrozenSegment): SharedFrozenSegment | null {
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
  const snapshot = freezeSegmentShared(payload, documents, segment.segmentId)
  return snapshot === null ? null : { snapshot, tombstonedDocIds: [] }
}
