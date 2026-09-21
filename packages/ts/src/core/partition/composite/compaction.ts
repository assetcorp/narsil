import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import type { FrozenSegment } from '../frozen'
import type { PartitionIndex } from '../index'
import type { PartitionReadState } from '../read-state'
import type { SegmentPayload } from '../segment-payload'

export type LiveTailFreezer = (payload: SegmentPayload, documents: AnyDocument[]) => FrozenSegment | null

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

export function survivorDocumentsOf(sub: PartitionReadState, payload: SegmentPayload): AnyDocument[] {
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

export function freezeLiveTailInto(
  live: PartitionIndex,
  liveState: PartitionReadState,
  frozen: FrozenSegment[],
  freeze: LiveTailFreezer,
): FrozenSegment | null {
  if (live.count() === 0) return null
  const payload = live.encodeSegment()
  const segment = freeze(payload, survivorDocumentsOf(liveState, payload))
  if (segment === null) return null
  live.clear()
  frozen.push(segment)
  return segment
}

export function swapFrozenSegmentList(
  frozen: FrozenSegment[],
  dropSegmentIds: readonly string[],
  replacement: FrozenSegment,
): void {
  const dropSet = new Set(dropSegmentIds)
  const dropped = frozen.filter(segment => dropSet.has(segment.segmentId))
  for (const segment of dropped) {
    for (const docId of segment.tombstonedDocIds()) {
      if (!replacement.hasDocument(docId)) continue
      if (dropped.some(other => other.hasDocument(docId))) continue
      replacement.tombstoneDocument(docId)
    }
  }
  const kept = frozen.filter(segment => !dropSet.has(segment.segmentId))
  frozen.length = 0
  frozen.push(...kept, replacement)
}
