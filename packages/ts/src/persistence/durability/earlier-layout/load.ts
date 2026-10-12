import { decode } from '@msgpack/msgpack'
import { createSharedFrozenSegment } from '../../../core/partition/frozen'
import { freezeSegmentShared } from '../../../core/partition/frozen/shared-snapshot'
import { buildSegmentPayload } from '../../../core/partition/segment-builder'
import { ErrorCodes, NarsilError } from '../../../errors'
import { resolvePartitionInsertOptions } from '../../../partitioning/insert-options'
import type { PartitionManager } from '../../../partitioning/manager'
import { openChecksummedEnvelope } from '../../../serialization/envelope-file'
import { HEADER_SIZE } from '../../../serialization/header'
import type { VectorIndex } from '../../../vector/vector-index'
import {
  decodeVectorFilePayload,
  decodeVectorGraphPayload,
  graphPartsOfEarlierPayload,
  type VectorGraphParts,
} from '../../../vector/vector-index/checkpoint-payload'
import { countDead } from '../../../vector/vector-index/dead-bits'
import type { PartitionCheckpoint } from '../partition-checkpoint'
import { growPartitionsTo } from '../segment/load'
import type { FileRef } from '../segment/manifest'
import type { CheckpointStore } from '../segment/store'
import { VECTOR_FILE_ENVELOPE_VERSION } from '../segment/vector-load'
import type { EarlierManifest, EarlierPartitionEntry, EarlierVectorFieldRef } from './manifest'
import { addSegmentSchema, mergeTimeOrderedSegments } from './merge'
import {
  type EarlierSegmentContents,
  type EarlierSegmentDocuments,
  readEarlierSegmentContents,
  readEarlierSegmentDocuments,
} from './segment'

export interface EarlierLoadDeps {
  manager: PartitionManager
  vectorIndexes: Map<string, VectorIndex>
  storedTermsAreCurrent: boolean
}

export interface EarlierLayoutLoaded {
  checkpoint: PartitionCheckpoint[]
  vectorFileRefs: Map<string, FileRef>
}

function removeWhatTheSegmentReplaces(manager: PartitionManager, segment: EarlierSegmentDocuments): void {
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

function attachDocuments(manager: PartitionManager, partitionId: number, segment: EarlierSegmentDocuments): void {
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

async function loadPartition(
  store: CheckpointStore,
  indexName: string,
  partition: EarlierPartitionEntry,
  deps: EarlierLoadDeps,
): Promise<void> {
  if (deps.storedTermsAreCurrent) {
    const agreedSchema: Record<string, string> = {}
    for (const ref of partition.segments) {
      const segment = await readEarlierSegmentDocuments(store, ref.key)
      addSegmentSchema(agreedSchema, segment.schema)
      removeWhatTheSegmentReplaces(deps.manager, segment)
      attachDocuments(deps.manager, partition.partitionId, segment)
    }
    return
  }
  const ordered: EarlierSegmentContents[] = []
  for (const ref of partition.segments) ordered.push(await readEarlierSegmentContents(store, ref.key))
  const merged = mergeTimeOrderedSegments(ordered, {
    indexName,
    partitionId: partition.partitionId,
    totalPartitions: deps.manager.partitionCount,
    language: deps.manager.language.name,
  })
  deps.manager.deserializePartition(partition.partitionId, merged)
}

async function readGraph(store: CheckpointStore, ref: EarlierVectorFieldRef): Promise<VectorGraphParts | null> {
  if (ref.graphKey === null) return null
  const bytes = await store.read(ref.graphKey)
  if (bytes === null) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The graph file "${ref.graphKey}" is missing`, {
      key: ref.graphKey,
    })
  }
  const { payload } = await openChecksummedEnvelope(bytes, {
    envelopeFormatVersion: VECTOR_FILE_ENVELOPE_VERSION,
    what: `graph file "${ref.graphKey}"`,
    allowsCompression: true,
  })
  return graphPartsOfEarlierPayload(decodeVectorGraphPayload(decode(payload)))
}

async function loadVectorField(
  store: CheckpointStore,
  ref: EarlierVectorFieldRef,
  vectorIndex: VectorIndex,
  fileRefs: Map<string, FileRef>,
): Promise<void> {
  let liveVectors = 0
  for (const file of ref.files) liveVectors += file.count - countDead(file.dead, file.count)
  const restore = vectorIndex.restoreCheckpoint({ liveVectors, holdsGraph: ref.graphKey !== null })
  for (const file of ref.files) {
    const bytes = await store.read(file.key)
    if (bytes === null) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The vector file "${file.key}" is missing`, {
        key: file.key,
      })
    }
    const { header, payload: payloadBytes } = await openChecksummedEnvelope(bytes, {
      envelopeFormatVersion: VECTOR_FILE_ENVELOPE_VERSION,
      what: `vector file "${file.key}"`,
      allowsCompression: false,
    })
    const payload = decodeVectorFilePayload(decode(payloadBytes))
    if (payload.docIds.length !== file.count) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `The vector file "${file.key}" holds ${payload.docIds.length} vectors where the manifest counts ${file.count}`,
        { key: file.key },
      )
    }
    fileRefs.set(file.key, { key: file.key, bytes: bytes.byteLength, checksum: header.checksum })
    restore.addFile({
      id: file.id,
      key: file.key,
      payload,
      dead: file.dead,
      location:
        store.pathOf === undefined
          ? null
          : {
              path: await store.pathOf(file.key),
              vectorsOffset: HEADER_SIZE + header.payloadLength - payload.vectors.byteLength,
            },
    })
  }
  restore.finish(await readGraph(store, ref))
}

export async function loadEarlierLayout(
  store: CheckpointStore,
  indexName: string,
  manifest: EarlierManifest,
  deps: EarlierLoadDeps,
): Promise<EarlierLayoutLoaded> {
  let highestPartitionId = manifest.partitions.length - 1
  for (const partition of manifest.partitions) {
    if (partition.partitionId > highestPartitionId) highestPartitionId = partition.partitionId
  }
  growPartitionsTo(deps.manager, highestPartitionId)
  for (const partition of manifest.partitions) {
    if (partition.partitionId >= deps.manager.partitionCount) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `Segment manifest references partition ${partition.partitionId} beyond the partition count ${deps.manager.partitionCount}`,
        { indexName, partitionId: partition.partitionId },
      )
    }
    await loadPartition(store, indexName, partition, deps)
  }
  const vectorFileRefs = new Map<string, FileRef>()
  for (const vector of manifest.vectors) {
    const vectorIndex = deps.vectorIndexes.get(vector.fieldPath)
    if (vectorIndex === undefined) continue
    await loadVectorField(store, vector, vectorIndex, vectorFileRefs)
  }
  return { checkpoint: manifest.checkpoint, vectorFileRefs }
}
