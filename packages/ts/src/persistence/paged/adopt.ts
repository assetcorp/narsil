import { isCompositePartition } from '../../core/partition/composite'
import type { FrozenSegment } from '../../core/partition/frozen'
import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import type { AnyDocument } from '../../types/schema'
import type { DiskAdoptionPartition, DiskAdoptionSegment } from '../../workers/protocol'
import type { DurableDirectory } from '../durability/durable-filesystem'
import type { PartitionManifestEntry } from '../durability/segment/manifest'
import { createPagedFrozenSegment } from './open-segment'
import { openPagedSnapshot } from './resident'
import { isPagedSegmentFile, pagedListingOf } from './verify'

const TOMBSTONES_BETWEEN_YIELDS = 4_096

interface PreparedSegment {
  segment: FrozenSegment
  isNew: boolean
}

export interface PreparedPartition {
  partitionId: number
  prepared: PreparedSegment[]
}

export interface PreparedAdoption {
  partitions: PreparedPartition[]
  droppedKeys: string[]
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function applyNewerTombstones(prepared: readonly PreparedSegment[]): void {
  for (let at = 0; at < prepared.length; at++) {
    if (!prepared[at].isNew) continue
    for (let newer = at + 1; newer < prepared.length; newer++) {
      const access = prepared[newer].segment.paged
      if (access === null) continue
      for (const docId of access.snapshot.tombstones) prepared[at].segment.tombstoneDocument(docId)
    }
  }
}

async function applyNewerTombstonesInTurns(prepared: readonly PreparedSegment[]): Promise<void> {
  let applied = 0
  for (let at = 0; at < prepared.length; at++) {
    if (!prepared[at].isNew) continue
    for (let newer = at + 1; newer < prepared.length; newer++) {
      const access = prepared[newer].segment.paged
      if (access === null) continue
      for (const docId of access.snapshot.tombstones) {
        prepared[at].segment.tombstoneDocument(docId)
        applied += 1
        if (applied % TOMBSTONES_BETWEEN_YIELDS === 0) await yieldToEventLoop()
      }
    }
  }
}

export async function prepareDiskAdoption(
  directory: DurableDirectory,
  manager: PartitionManager,
  partitions: readonly PartitionManifestEntry[],
): Promise<PreparedAdoption | null> {
  for (const entry of partitions) {
    for (const ref of entry.segments) {
      if (!(await isPagedSegmentFile(directory, ref.key))) return null
    }
  }
  const prepared: PreparedPartition[] = []
  const droppedKeys: string[] = []
  for (const entry of partitions) {
    if (entry.partitionId >= manager.partitionCount) continue
    const partition = manager.getPartition(entry.partitionId)
    const held = new Map<string, FrozenSegment>()
    if (isCompositePartition(partition)) {
      for (const segment of partition.frozenSegments()) {
        if (segment.paged !== null) held.set(segment.paged.key, segment)
      }
    }
    const list: PreparedSegment[] = []
    for (const ref of entry.segments) {
      const existing = held.get(ref.key)
      if (existing !== undefined) {
        held.delete(ref.key)
        list.push({ segment: existing, isNew: false })
        continue
      }
      const snapshot = openPagedSnapshot(await pagedListingOf(directory, ref))
      list.push({ segment: createPagedFrozenSegment(snapshot), isNew: true })
    }
    droppedKeys.push(...held.keys())
    await applyNewerTombstonesInTurns(list)
    prepared.push({ partitionId: entry.partitionId, prepared: list })
  }
  return { partitions: prepared, droppedKeys }
}

export function closeUnusedSegments(adoption: PreparedAdoption): void {
  for (const { prepared } of adoption.partitions) {
    for (const { segment, isNew } of prepared) {
      if (isNew) segment.paged?.close()
    }
  }
}

export function actionPartitionsOf(adoption: PreparedAdoption): DiskAdoptionPartition[] {
  return adoption.partitions.map(({ partitionId, prepared }) => ({
    partitionId,
    segments: prepared.map(({ segment, isNew }): DiskAdoptionSegment => {
      const access = segment.paged
      if (access !== null && isNew) return { snapshot: access.snapshot }
      return { segmentId: segment.segmentId }
    }),
  }))
}

export function swapPreparedPartitions(
  manager: PartitionManager,
  partitions: readonly PreparedPartition[],
  changed: ReadonlySet<string>,
  onSwapped?: (partitionId: number, segments: readonly FrozenSegment[]) => void,
): void {
  for (const { partitionId, prepared } of partitions) {
    const kept: FrozenSegment[] = []
    for (const { segment } of prepared) {
      if (segment.arrays.documentCount > 0) kept.push(segment)
      else segment.paged?.close()
    }
    adoptDiskSegments(manager, partitionId, kept, changed)
    onSwapped?.(partitionId, kept)
  }
}

function adoptDiskSegments(
  manager: PartitionManager,
  partitionId: number,
  segments: readonly FrozenSegment[],
  changed: ReadonlySet<string>,
): void {
  const { composite, docPartitionMap, insertOptions } = manager.diskSegmentAccess(partitionId)
  const before = composite.frozenSegments()
  const kept: Array<[string, AnyDocument]> = []
  for (const docId of changed) {
    if (docPartitionMap.get(docId) !== partitionId) continue
    const document = composite.getRef(docId)
    if (document !== undefined) kept.push([docId, document])
  }
  const dropped = before.filter(segment => !segments.includes(segment))
  for (const segment of segments) {
    if (before.includes(segment)) continue
    for (const docId of changed) segment.tombstoneDocument(docId)
  }
  composite.replaceFrozenSegments(segments)
  composite.live.clear()
  for (const [docId, pid] of docPartitionMap) {
    if (pid === partitionId) docPartitionMap.delete(docId)
  }
  composite.live.beginBatch()
  try {
    for (const [docId, document] of kept) {
      composite.live.insert(docId, document, manager.config.schema, manager.language, insertOptions)
      docPartitionMap.set(docId, partitionId)
    }
  } finally {
    composite.live.endBatch()
  }
  for (const segment of dropped) segment.paged?.close()
}

export function adoptSegmentsOnWorker(
  manager: PartitionManager,
  action: { indexName: string; partitions: readonly DiskAdoptionPartition[]; changed: readonly string[] },
): void {
  const partitions = action.partitions.map(({ partitionId, segments }) => {
    const partition = manager.getPartition(partitionId)
    const held = isCompositePartition(partition) ? partition.frozenSegments() : []
    const prepared = segments.map(item => {
      if ('snapshot' in item) return { segment: createPagedFrozenSegment(item.snapshot), isNew: true }
      const existing = held.find(segment => segment.segmentId === item.segmentId)
      if (existing === undefined) {
        throw new NarsilError(
          ErrorCodes.PARTITION_CORRUPTED,
          `Partition ${partitionId} of "${action.indexName}" holds no segment "${item.segmentId}" to keep`,
          { indexName: action.indexName, partitionId, segmentId: item.segmentId },
        )
      }
      return { segment: existing, isNew: false }
    })
    applyNewerTombstones(prepared)
    return { partitionId, prepared }
  })
  swapPreparedPartitions(manager, partitions, new Set(action.changed))
}
