import type { ResolvedAnalysis } from '../../analysis/registry'
import { generateId } from '../../core/id-generator'
import { createPartitionIndex, type PartitionIndex } from '../../core/partition'
import { createCompositePartition, isCompositePartition } from '../../core/partition/composite'
import {
  createFrozenSegment,
  createSharedFrozenSegment,
  type FrozenSegment,
  freezeSegmentShared,
} from '../../core/partition/frozen'
import type { TextAnalysis } from '../../core/partition/frozen/surface-slot'
import type { PartialWordAnalysis } from '../../core/partition/partial-words/spellings'
import { resolvePartitionInsertOptions } from '../../partitioning/insert-options'
import type { PartitionManager } from '../../partitioning/manager'
import { flattenSchema } from '../../schema/validator/schema'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig } from '../../types/schema'
import type { DurableDirectory } from '../durability/durable-filesystem'
import type { WriteRecordKeeper } from '../durability/types'
import { REWRITE_SPILL_BYTES } from './constants'
import { createPagedFrozenSegment } from './open-segment'
import { openPagedSnapshot } from './resident'
import { pagedListingOf } from './verify'
import { writePagedSegment } from './write-segment'

export interface RewriteStorage {
  directory: DurableDirectory
  writeRecords: WriteRecordKeeper | null
}

export interface RewriteAnalysis {
  schema: Record<string, string>
  trackPositions: boolean
  partialWordAnalysis: PartialWordAnalysis | null
  textAnalysis: TextAnalysis
}

export interface RewriteSpill {
  newPartition(partitionId: number): PartitionIndex
  spillIfFull(partition: PartitionIndex, partitionId: number): Promise<void>
  abandon(): Promise<void>
  removeUnread(manager: PartitionManager): Promise<void>
}

export interface RewriteTarget {
  config: IndexConfig
  language: LanguageModule
  analysis: ResolvedAnalysis
  partialWordAnalysis: PartialWordAnalysis | null
}

export function openRewriteSpill(
  storage: RewriteStorage,
  manager: PartitionManager,
  target?: RewriteTarget,
): RewriteSpill {
  const config = target?.config ?? manager.config
  return createRewriteSpill(storage, manager.indexName, {
    schema: flattenSchema(config.schema),
    trackPositions: config.trackPositions ?? true,
    partialWordAnalysis: target === undefined ? manager.partialWordAnalysis : target.partialWordAnalysis,
    textAnalysis: {
      language: target?.language ?? manager.language,
      options: resolvePartitionInsertOptions(config, target?.analysis ?? manager.analysis),
    },
  })
}

function createRewriteSpill(storage: RewriteStorage, indexName: string, analysis: RewriteAnalysis): RewriteSpill {
  const { directory, writeRecords } = storage
  const prefix = `${indexName}/rebuilt/${generateId()}/`
  const opened: FrozenSegment[] = []
  let nextFile = 0

  async function removeFiles(): Promise<void> {
    for (const key of await directory.list(prefix)) await directory.remove(key)
  }

  function freezeLive(partition: PartitionIndex): FrozenSegment | null {
    if (!isCompositePartition(partition)) return null
    return partition.freezeLiveTail((payload, documents) => {
      const snapshot = freezeSegmentShared(payload, documents, undefined, analysis.partialWordAnalysis)
      return snapshot === null ? createFrozenSegment(payload, documents) : createSharedFrozenSegment(snapshot)
    })
  }

  return {
    newPartition(partitionId) {
      const live = createPartitionIndex(partitionId, analysis.trackPositions)
      return createCompositePartition(partitionId, analysis.trackPositions, live, analysis.textAnalysis)
    },

    async spillIfFull(partition, partitionId) {
      if (!isCompositePartition(partition)) return
      if (partition.live.estimateMemoryBytes() < REWRITE_SPILL_BYTES) return
      const frozen = freezeLive(partition)
      if (frozen === null) return
      const key = `${prefix}${nextFile}`
      nextFile += 1
      const written = await writePagedSegment({
        directory,
        key,
        schema: analysis.schema,
        tombstones: [],
        selections: [{ segment: frozen, keep: ordinal => !frozen.isTombstoned(ordinal) }],
        partialWordAnalysis: analysis.partialWordAnalysis,
        textAnalysis: analysis.textAnalysis,
        ...(writeRecords === null
          ? {}
          : { writeRecords: writeRecords.captureSegments(indexName, partitionId, [frozen]) }),
      })
      const listing = await pagedListingOf(directory, { key, bytes: written.bytes, checksum: written.checksum })
      const segment = createPagedFrozenSegment(openPagedSnapshot(listing))
      opened.push(segment)
      partition.swapFrozenSegments([frozen.segmentId], segment)
    },

    async abandon() {
      for (const segment of opened.splice(0)) segment.paged?.close()
      await removeFiles()
    },

    async removeUnread(manager) {
      for (const partition of manager.getAllPartitions()) {
        if (!isCompositePartition(partition)) continue
        for (const segment of partition.frozenSegments()) {
          if (segment.paged?.key.startsWith(prefix)) return
        }
      }
      for (const segment of opened.splice(0)) segment.paged?.close()
      await removeFiles()
    },
  }
}
