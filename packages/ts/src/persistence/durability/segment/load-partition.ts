import { createSharedFrozenSegment, type FrozenSegment, shareSegmentArrays } from '../../../core/partition/frozen'
import { decodeEveryStoredDocument } from '../../../core/partition/frozen/document-source'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { PartitionManager } from '../../../partitioning/manager'
import type { KeywordSegmentContents } from '../../../serialization/keyword-segment/types'
import type { WriteRecordKeeper } from '../types'
import type { PartitionManifestEntry } from './manifest'
import { readSegmentFile } from './segment-file'
import type { CheckpointStore } from './store'

export interface PartitionLoadOptions {
  schema: Record<string, string>
  decodesEveryDocument: boolean
  writeRecords?: WriteRecordKeeper | null
}

function requireAgreedSchema(agreed: Record<string, string>, schema: Record<string, string>, key: string): void {
  for (const [field, type] of Object.entries(schema)) {
    const existing = agreed[field]
    if (existing !== undefined && existing !== type) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `The segment "${key}" gives field "${field}" the type "${type}", while the index gives it "${existing}"`,
        { key, field, existing, found: type },
      )
    }
  }
}

function removeWhatTheSegmentReplaces(
  manager: PartitionManager,
  segment: FrozenSegment,
  contents: KeywordSegmentContents,
): void {
  manager.beginBatchRemove()
  try {
    for (const docId of contents.tombstones) {
      if (manager.has(docId)) manager.remove(docId)
    }
    const ids = segment.arrays.idTable
    for (let ordinal = 0; ordinal < ids.count; ordinal++) {
      const docId = ids.idAt(ordinal)
      if (manager.has(docId)) manager.remove(docId)
    }
  } finally {
    manager.endBatchRemove()
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

export async function loadPartitionSegments(
  store: CheckpointStore,
  partition: PartitionManifestEntry,
  manager: PartitionManager,
  options: PartitionLoadOptions,
): Promise<void> {
  for (const ref of partition.segments) {
    const contents = await readSegmentFile(store, ref)
    requireAgreedSchema(options.schema, contents.schema, ref.key)
    if (options.decodesEveryDocument) decodeEveryStoredDocument(contents.arrays.documentTable)
    const segment = createSharedFrozenSegment(shareSegmentArrays(contents.arrays, manager.partialWordAnalysis))
    removeWhatTheSegmentReplaces(manager, segment, contents)
    options.writeRecords?.loadSegment(manager.indexName, partition.partitionId, segment, contents)
    if (contents.arrays.documentCount > 0) manager.attachFrozenSegment(partition.partitionId, segment)
    await yieldToEventLoop()
  }
}
