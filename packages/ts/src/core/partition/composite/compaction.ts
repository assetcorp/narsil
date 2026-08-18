import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import type { FrozenSegment } from '../frozen'
import { createPartitionIndex } from '../index'
import type { PartitionReadState } from '../read-state'
import { encodeSegmentState, type SegmentPayload } from '../segment-payload'

export function resolveFrozenSegments(
  frozen: readonly FrozenSegment[],
  segmentIds: readonly string[],
  partitionId: number,
): FrozenSegment[] {
  const byId = new Map(frozen.map(segment => [segment.segmentId, segment]))
  return segmentIds.map(segmentId => {
    const segment = byId.get(segmentId)
    if (segment === undefined) {
      throw new NarsilError(
        ErrorCodes.PARTITION_CORRUPTED,
        `Partition ${partitionId} does not hold frozen segment "${segmentId}"`,
        { partitionId, segmentId },
      )
    }
    return segment
  })
}

function survivorDocumentsOf(sub: PartitionReadState, payload: SegmentPayload): AnyDocument[] {
  return payload.docIds.map(docId => {
    const stored = sub.docStore.get(docId)
    if (stored === undefined) {
      throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, `Document "${docId}" vanished while compacting a segment`, {
        docId,
      })
    }
    return stored.fields as AnyDocument
  })
}

export function buildCompactedSegmentPayload(segments: readonly FrozenSegment[]): {
  payload: SegmentPayload
  documents: AnyDocument[]
} {
  const scratch = createPartitionIndex(0)
  const documents: AnyDocument[] = []
  for (const segment of segments) {
    const payload = encodeSegmentState(segment)
    if (payload.documentCount === 0) continue
    const segmentDocuments = survivorDocumentsOf(segment, payload)
    scratch.mergeSegmentPayload(payload, segmentDocuments)
    documents.push(...segmentDocuments)
  }
  return { payload: scratch.encodeSegment(), documents }
}

export function swapFrozenSegmentList(
  frozen: FrozenSegment[],
  dropSegmentIds: readonly string[],
  replacement: FrozenSegment,
  partitionId: number,
): void {
  const dropped = resolveFrozenSegments(frozen, dropSegmentIds, partitionId)
  const dropSet = new Set(dropSegmentIds)
  for (const ordinal of replacement.docStore.allInternalIds()) {
    const docId = replacement.docStore.getExternalId(ordinal)
    if (docId === undefined) continue
    let liveInDropped = false
    for (const segment of dropped) {
      if (segment.hasDocument(docId)) {
        liveInDropped = true
        break
      }
    }
    if (!liveInDropped) replacement.tombstoneDocument(docId)
  }
  const kept = frozen.filter(segment => !dropSet.has(segment.segmentId))
  frozen.length = 0
  frozen.push(...kept, replacement)
}
