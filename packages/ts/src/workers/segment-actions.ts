import { isCompositePartition } from '../core/partition/composite'
import { createSharedFrozenSegment, freezeSegmentShared } from '../core/partition/frozen'
import { mergeFrozenSegments } from '../core/partition/frozen/merge'
import { buildSegmentPayload } from '../core/partition/segment-builder'
import { ErrorCodes, NarsilError } from '../errors'
import { resolvePartitionInsertOptions } from '../partitioning/insert-options'
import type { PartitionManager } from '../partitioning/manager'
import type { LanguageModule } from '../types/language'
import type { IndexConfig } from '../types/schema'
import type { BuiltSegmentResult, WorkerAction } from './protocol'

export interface SegmentIndexEntry {
  manager: PartitionManager
  config: IndexConfig
  language: LanguageModule
}

export type SegmentAction = Extract<
  WorkerAction,
  { type: 'buildSegment' | 'mergeSegments' | 'attachSegments' | 'compactSegments' | 'swapSegments' | 'freezeLiveTail' }
>

export function isSegmentAction(action: WorkerAction): action is SegmentAction {
  return (
    action.type === 'buildSegment' ||
    action.type === 'mergeSegments' ||
    action.type === 'attachSegments' ||
    action.type === 'compactSegments' ||
    action.type === 'swapSegments' ||
    action.type === 'freezeLiveTail'
  )
}

export function growPartitionsTo(manager: PartitionManager, partitionId: number): void {
  while (manager.partitionCount <= partitionId) {
    manager.addPartition()
  }
}

function requireComposite(entry: SegmentIndexEntry, indexName: string, partitionId: number, verb: string) {
  const partition = entry.manager.getPartition(partitionId)
  if (!isCompositePartition(partition)) {
    throw new NarsilError(
      ErrorCodes.PARTITION_CORRUPTED,
      `Partition ${partitionId} of "${indexName}" holds no frozen segments to ${verb}`,
      { indexName, partitionId },
    )
  }
  return partition
}

export function runSegmentAction(entry: SegmentIndexEntry, action: SegmentAction): unknown {
  switch (action.type) {
    case 'buildSegment': {
      const options = resolvePartitionInsertOptions(entry.config, entry.manager.analysis, action.options)
      const payload = buildSegmentPayload(
        action.documents,
        entry.config.schema,
        entry.language,
        options,
        entry.config.trackPositions ?? true,
      )
      const snapshot = freezeSegmentShared(
        payload,
        action.documents.map(doc => doc.document),
        action.segmentId,
      )
      const built: BuiltSegmentResult = snapshot === null ? { kind: 'payload', payload } : { kind: 'shared', snapshot }
      return built
    }

    case 'mergeSegments': {
      for (const segment of action.segments) {
        if (segment.payload.docIds.some(docId => entry.manager.has(docId))) {
          console.warn(
            `Skipping replicated segment for index "${action.indexName}": its documents already exist on this copy`,
          )
          continue
        }
        entry.manager.mergeSegment(segment.partitionId, segment.payload, segment.documents)
      }
      return undefined
    }

    case 'attachSegments': {
      for (const segment of action.segments) {
        growPartitionsTo(entry.manager, segment.partitionId)
        const frozen = createSharedFrozenSegment(segment.snapshot)
        for (const docId of segment.tombstonedDocIds ?? []) frozen.tombstoneDocument(docId)
        entry.manager.attachFrozenSegment(segment.partitionId, frozen)
      }
      return undefined
    }

    case 'compactSegments': {
      const partition = requireComposite(entry, action.indexName, action.partitionId, 'compact')
      return mergeFrozenSegments(partition.frozenSegmentsById(action.segmentIds))
    }

    case 'swapSegments': {
      requireComposite(entry, action.indexName, action.partitionId, 'swap')
      entry.manager.swapFrozenSegments(
        action.partitionId,
        action.dropSegmentIds,
        createSharedFrozenSegment(action.snapshot),
      )
      return undefined
    }

    case 'freezeLiveTail': {
      growPartitionsTo(entry.manager, action.partitionId)
      const tail = entry.manager.getPartition(action.partitionId)
      const held = isCompositePartition(tail) ? tail.live.count() : tail.count()
      if (held !== action.snapshot.documentCount) {
        console.warn(
          `Partition ${action.partitionId} of "${action.indexName}" held ${held} live documents where the frozen tail holds ${action.snapshot.documentCount}`,
        )
      }
      entry.manager.replaceLiveTail(action.partitionId, createSharedFrozenSegment(action.snapshot))
      return undefined
    }
  }
}
