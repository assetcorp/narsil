import { isCompositePartition } from '../core/partition/composite'
import type { PagedSegmentSnapshot, SharedSegmentSnapshot } from '../core/partition/frozen'
import { mergeFrozenSegmentOutputs } from '../core/partition/frozen/merge-split'
import { NO_REMOVED_SPELLINGS } from '../core/partition/frozen/removal-pass'
import { createSharedFrozenSegment } from '../core/partition/frozen/shared'
import { freezeSegmentShared } from '../core/partition/frozen/shared-snapshot'
import { buildSegmentPayloads } from '../core/partition/segment-builder'
import { ErrorCodes, NarsilError } from '../errors'
import { resolvePartitionInsertOptions } from '../partitioning/insert-options'
import type { PartitionManager } from '../partitioning/manager'
import type { LanguageModule } from '../types/language'
import type { IndexConfig } from '../types/schema'
import type { BuiltSegmentResult } from './protocol'
import { growPartitionsTo, type SegmentAction } from './segment-action-code'

export interface SegmentIndexEntry {
  manager: PartitionManager
  config: IndexConfig
  language: LanguageModule
}

function isPagedSnapshot(snapshot: SharedSegmentSnapshot | PagedSegmentSnapshot): snapshot is PagedSegmentSnapshot {
  return 'path' in snapshot
}

async function attachSegments(
  entry: SegmentIndexEntry,
  action: Extract<SegmentAction, { type: 'attachSegments' }>,
): Promise<void> {
  for (const segment of action.segments) {
    growPartitionsTo(entry.manager, segment.partitionId)
    const surfaceForms = segment.survivingSurfaceForms
    const spellings = surfaceForms === undefined ? undefined : NO_REMOVED_SPELLINGS
    const frozen = isPagedSnapshot(segment.snapshot)
      ? (await import('../persistence/paged/module')).createPagedFrozenSegment(segment.snapshot)
      : createSharedFrozenSegment(segment.snapshot, surfaceForms)
    for (const docId of segment.tombstonedDocIds ?? []) frozen.tombstoneDocument(docId, spellings)
    entry.manager.attachFrozenSegment(segment.partitionId, frozen)
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
      const outputs = buildSegmentPayloads(
        action.documents,
        entry.config.schema,
        entry.language,
        options,
        entry.config.trackPositions ?? true,
      )
      return outputs.map(({ payload, documents }, index): BuiltSegmentResult => {
        const snapshot = freezeSegmentShared(
          payload,
          documents.map(doc => doc.document),
          index === 0 ? action.segmentId : undefined,
        )
        return snapshot === null ? { kind: 'payload', payload } : { kind: 'shared', snapshot }
      })
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

    case 'attachSegments':
      return attachSegments(entry, action)

    case 'adoptDiskSegments':
      return import('../persistence/paged/module').then(code => code.adoptSegmentsOnWorker(entry.manager, action))

    case 'compactSegments': {
      const partition = requireComposite(entry, action.indexName, action.partitionId, 'compact')
      return mergeFrozenSegmentOutputs(
        partition.frozenSegmentsById(action.segmentIds),
        entry.manager.partialWordAnalysis,
        entry.manager.textAnalysis,
      )
    }

    case 'swapSegments': {
      requireComposite(entry, action.indexName, action.partitionId, 'swap')
      entry.manager.swapFrozenSegments(
        action.partitionId,
        action.dropSegmentIds,
        action.snapshots.map(snapshot => createSharedFrozenSegment(snapshot)),
        action.removedSpellings,
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
