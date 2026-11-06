import { createSharedFrozenSegment, type FrozenSegment, shareSegmentArrays } from '../../../core/partition/frozen'
import { decodeEveryStoredDocument } from '../../../core/partition/frozen/document-source'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { PartitionManager } from '../../../partitioning/manager'
import type { KeywordSegmentContents } from '../../../serialization/keyword-segment/types'
import type { DurableDirectory } from '../durable-filesystem'
import type { WriteRecordKeeper } from '../types'
import type { PartitionManifestEntry, SegmentRef } from './manifest'
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

function removeFromPartition(manager: PartitionManager, partitionId: number, docIds: readonly string[]): void {
  const { composite, docPartitionMap, insertOptions } = manager.diskSegmentAccess(partitionId)
  composite.beginBatch()
  try {
    for (const docId of docIds) {
      if (!composite.has(docId)) continue
      composite.remove(docId, manager.config.schema, manager.language, insertOptions)
      docPartitionMap.delete(docId)
    }
  } finally {
    composite.endBatch()
  }
}

async function attachPagedSegment(
  directory: DurableDirectory,
  ref: SegmentRef,
  partitionId: number,
  manager: PartitionManager,
  options: PartitionLoadOptions,
): Promise<FrozenSegment | null> {
  const { checkPagedSegmentFully, createPagedFrozenSegment, openPagedSnapshot, pagedListingOf } = await import(
    '../../paged/module'
  )
  if (options.decodesEveryDocument) await checkPagedSegmentFully(directory, ref)
  const snapshot = openPagedSnapshot(await pagedListingOf(directory, ref))
  requireAgreedSchema(options.schema, snapshot.schema, ref.key)
  const segment = createPagedFrozenSegment(snapshot)
  removeFromPartition(manager, partitionId, snapshot.tombstones)
  options.writeRecords?.loadPagedSegment(manager.indexName, partitionId, segment)
  if (snapshot.documentCount > 0) {
    manager.attachFrozenSegment(partitionId, segment)
    return segment
  }
  segment.paged?.close()
  return null
}

function documentsHeldBefore(manager: PartitionManager, partitionId: number): string[] {
  const held = manager.partitionAt(partitionId)
  return held === undefined ? [] : [...held.docIds()]
}

function removeDocumentsMissingFromLoadedSegments(
  manager: PartitionManager,
  partitionId: number,
  heldBefore: readonly string[],
  loaded: readonly FrozenSegment[],
): void {
  const absent = heldBefore.filter(
    docId => manager.partitionIdOf(docId) === partitionId && !loaded.some(segment => segment.hasDocument(docId)),
  )
  if (absent.length === 0) return
  manager.beginBatchRemove()
  try {
    for (const docId of absent) manager.remove(docId)
  } finally {
    manager.endBatchRemove()
  }
}

export async function loadPartitionSegments(
  store: CheckpointStore,
  partition: PartitionManifestEntry,
  manager: PartitionManager,
  options: PartitionLoadOptions,
): Promise<void> {
  const heldBefore = documentsHeldBefore(manager, partition.partitionId)
  const loaded = await attachPartitionSegments(store, partition, manager, options)
  removeDocumentsMissingFromLoadedSegments(manager, partition.partitionId, heldBefore, loaded)
}

async function attachPartitionSegments(
  store: CheckpointStore,
  partition: PartitionManifestEntry,
  manager: PartitionManager,
  options: PartitionLoadOptions,
): Promise<FrozenSegment[]> {
  const loaded: FrozenSegment[] = []
  const { directory } = store
  for (const ref of partition.segments) {
    if (manager.config.textStorage === 'disk' && directory !== undefined) {
      const { isPagedSegmentFile } = await import('../../paged/module')
      if (await isPagedSegmentFile(directory, ref.key)) {
        const paged = await attachPagedSegment(directory, ref, partition.partitionId, manager, options)
        if (paged !== null) loaded.push(paged)
        await yieldToEventLoop()
        continue
      }
    }
    const contents = await readSegmentFile(store, ref)
    requireAgreedSchema(options.schema, contents.schema, ref.key)
    if (options.decodesEveryDocument) decodeEveryStoredDocument(contents.arrays.documentTable)
    const segment = createSharedFrozenSegment(shareSegmentArrays(contents.arrays, manager.partialWordAnalysis))
    removeWhatTheSegmentReplaces(manager, segment, contents)
    options.writeRecords?.loadSegment(manager.indexName, partition.partitionId, segment, contents)
    if (contents.arrays.documentCount > 0) {
      manager.attachFrozenSegment(partition.partitionId, segment)
      loaded.push(segment)
    }
    await yieldToEventLoop()
  }
  return loaded
}
