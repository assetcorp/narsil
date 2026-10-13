import { isCompositePartition } from '../../../core/partition/composite'
import { survivorDocumentsOf } from '../../../core/partition/composite/compaction'
import { createFrozenSegment, createSharedFrozenSegment, type FrozenSegment } from '../../../core/partition/frozen'
import type { SegmentSelection } from '../../../core/partition/frozen/merge'
import { freezeSegmentShared, type SharedSegmentSnapshot } from '../../../core/partition/frozen/shared-snapshot'
import { type PartitionIndex, partitionStateOf } from '../../../core/partition/index'
import type { PartitionManager } from '../../../partitioning/manager'

export interface CapturedSegment {
  snapshot: SharedSegmentSnapshot
  keep: Uint8Array
}

export interface CapturedWholePartition {
  partitionId: number
  docCount: number
  segments: CapturedSegment[]
}

export interface PartitionContents {
  partitionId: number
  docCount: number
  selections: SegmentSelection[]
}

export type CapturablePartitions = Pick<PartitionManager, 'getPartition'>

function keepMaskOf(segment: FrozenSegment): Uint8Array {
  const keep = new Uint8Array(segment.arrays.documentCount)
  for (let ordinal = 0; ordinal < keep.length; ordinal++) keep[ordinal] = segment.isTombstoned(ordinal) ? 0 : 1
  return keep
}

function selectionOfMask(segment: FrozenSegment, keep: Uint8Array): SegmentSelection {
  return { segment, keep: ordinal => keep[ordinal] === 1 }
}

function frozenLiveTail(live: PartitionIndex, shared: boolean): FrozenSegment | null {
  if (live.count() === 0) return null
  const payload = live.encodeSegment()
  const documents = survivorDocumentsOf(partitionStateOf(live), payload)
  if (shared) {
    const snapshot = freezeSegmentShared(payload, documents)
    if (snapshot !== null) return createSharedFrozenSegment(snapshot)
  }
  return createFrozenSegment(payload, documents)
}

function frozenSegmentsOf(partition: PartitionIndex, shared: boolean): FrozenSegment[] {
  const segments: FrozenSegment[] = []
  const live = isCompositePartition(partition) ? partition.live : partition
  if (isCompositePartition(partition)) {
    const ids = partition.frozenSegmentSizes().map(size => size.segmentId)
    segments.push(...partition.frozenSegmentsById(ids))
  }
  const tail = frozenLiveTail(live, shared)
  if (tail !== null) segments.push(tail)
  return segments
}

export function partitionContentsOf(manager: CapturablePartitions, partitionId: number): PartitionContents {
  const partition = manager.getPartition(partitionId)
  const selections = frozenSegmentsOf(partition, false).map(segment => selectionOfMask(segment, keepMaskOf(segment)))
  return { partitionId, docCount: partition.count(), selections }
}

export function captureWholePartition(
  manager: CapturablePartitions,
  partitionId: number,
): CapturedWholePartition | null {
  if (typeof SharedArrayBuffer !== 'function') return null
  const partition = manager.getPartition(partitionId)
  if (!isCompositePartition(partition) || partition.frozenSegmentCount() === 0) return null
  const segments: CapturedSegment[] = []
  for (const segment of frozenSegmentsOf(partition, true)) {
    if (segment.sharedSnapshot === null) return null
    segments.push({ snapshot: segment.sharedSnapshot, keep: keepMaskOf(segment) })
  }
  return { partitionId, docCount: partition.count(), segments }
}

export function contentsOfCaptured(captured: CapturedWholePartition): PartitionContents {
  return {
    partitionId: captured.partitionId,
    docCount: captured.docCount,
    selections: captured.segments.map(({ snapshot, keep }) =>
      selectionOfMask(createSharedFrozenSegment(snapshot), keep),
    ),
  }
}
