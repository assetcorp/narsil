import { createSharedFrozenSegment } from '../../../core/partition/frozen'
import { freezeSegmentShared } from '../../../core/partition/frozen/shared-snapshot'
import { buildSegmentPayload } from '../../../core/partition/segment-builder'
import { resolvePartitionInsertOptions } from '../../../partitioning/insert-options'
import type { PartitionManager } from '../../../partitioning/manager'
import type { DurableDirectory } from '../durable-filesystem'
import type { PartitionManifestEntry } from './manifest'
import { addSegmentSchema } from './merge'
import { readSegmentDocuments, type SegmentDocuments } from './segment-file'

function removeWhatTheSegmentReplaces(manager: PartitionManager, segment: SegmentDocuments): void {
  manager.beginBatchRemove()
  try {
    for (const docId of segment.tombstones) {
      if (manager.has(docId)) manager.remove(docId)
    }
    for (const { docId } of segment.documents) {
      if (manager.has(docId)) manager.remove(docId)
    }
  } finally {
    manager.endBatchRemove()
  }
}

function attachDocuments(manager: PartitionManager, partitionId: number, segment: SegmentDocuments): void {
  if (segment.documents.length === 0) return
  const payload = buildSegmentPayload(
    segment.documents,
    manager.config.schema,
    manager.language,
    resolvePartitionInsertOptions(manager.config, manager.analysis),
    manager.config.trackPositions ?? true,
  )
  const documents = segment.documents.map(entry => entry.document)
  const snapshot = freezeSegmentShared(payload, documents)
  if (snapshot === null) {
    manager.mergeSegment(partitionId, payload, documents)
    return
  }
  manager.attachFrozenSegment(partitionId, createSharedFrozenSegment(snapshot))
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

export async function loadPartitionSegmentBySegment(
  directory: DurableDirectory,
  partition: PartitionManifestEntry,
  manager: PartitionManager,
): Promise<void> {
  const agreedSchema: Record<string, string> = {}
  for (const ref of partition.segments) {
    const segment = await readSegmentDocuments(directory, ref.key)
    addSegmentSchema(agreedSchema, segment.schema)
    removeWhatTheSegmentReplaces(manager, segment)
    attachDocuments(manager, partition.partitionId, segment)
    await yieldToEventLoop()
  }
}
