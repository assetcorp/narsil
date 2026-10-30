import { isCompositePartition } from '../../../core/partition/composite'
import { survivorDocumentsOf } from '../../../core/partition/composite/compaction'
import { createFrozenSegment, createSharedFrozenSegment, type FrozenSegment } from '../../../core/partition/frozen'
import type { SegmentSelection } from '../../../core/partition/frozen/merge'
import { freezeSegmentShared, type SharedSegmentSnapshot } from '../../../core/partition/frozen/shared-snapshot'
import { type PartitionIndex, partitionStateOf } from '../../../core/partition/index'
import type { PartitionManager } from '../../../partitioning/manager'
import type { SegmentWriteRecords } from '../../../serialization/keyword-segment/types'

export interface CapturedSegment {
  snapshot: SharedSegmentSnapshot
  keep: Uint8Array
  writeRecords?: SegmentWriteRecords
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
  writeRecords?: Map<FrozenSegment, SegmentWriteRecords>
}

export type WriteRecordCapture = (segments: readonly FrozenSegment[]) => Map<FrozenSegment, SegmentWriteRecords>

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

export function partitionContentsOf(
  manager: CapturablePartitions,
  partitionId: number,
  captureRecords?: WriteRecordCapture,
): PartitionContents {
  const partition = manager.getPartition(partitionId)
  const segments = frozenSegmentsOf(partition, false)
  const selections = segments.map(segment => selectionOfMask(segment, keepMaskOf(segment)))
  const contents: PartitionContents = { partitionId, docCount: partition.count(), selections }
  if (captureRecords !== undefined) contents.writeRecords = captureRecords(segments)
  return contents
}

export function captureWholePartition(
  manager: CapturablePartitions,
  partitionId: number,
  captureRecords?: WriteRecordCapture,
): CapturedWholePartition | null {
  if (typeof SharedArrayBuffer !== 'function') return null
  const partition = manager.getPartition(partitionId)
  if (!isCompositePartition(partition) || partition.frozenSegmentCount() === 0) return null
  const frozen = frozenSegmentsOf(partition, true)
  const records = captureRecords?.(frozen)
  const segments: CapturedSegment[] = []
  for (const segment of frozen) {
    if (segment.sharedSnapshot === null) return null
    const captured: CapturedSegment = { snapshot: segment.sharedSnapshot, keep: keepMaskOf(segment) }
    const held = records?.get(segment)
    if (held !== undefined) captured.writeRecords = held
    segments.push(captured)
  }
  return { partitionId, docCount: partition.count(), segments }
}

export function contentsOfCaptured(captured: CapturedWholePartition): PartitionContents {
  const writeRecords = new Map<FrozenSegment, SegmentWriteRecords>()
  const selections = captured.segments.map(({ snapshot, keep, writeRecords: held }) => {
    const segment = createSharedFrozenSegment(snapshot)
    if (held !== undefined) writeRecords.set(segment, held)
    return selectionOfMask(segment, keep)
  })
  const contents: PartitionContents = { partitionId: captured.partitionId, docCount: captured.docCount, selections }
  if (writeRecords.size > 0) contents.writeRecords = writeRecords
  return contents
}
