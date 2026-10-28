import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import { buildArchiveFromMemory } from '../../persistence/archive/from-memory'
import { validateStagedCheckpoint } from '../../persistence/archive/validate'
import type { RestoreStaging } from '../../persistence/durability/restore-staging'
import { manifestFileRefs } from '../../persistence/durability/segment/manifest'
import { raiseEarlierReleaseGraphSetting } from '../../schema/validator'
import { unpackIndexSnapshotEnvelope } from '../../serialization/envelope'
import { deserializePayloadV1 } from '../../serialization/payload-v1'
import { documentsOfPayloadV2 } from '../../serialization/payload-v2'
import type { SerializablePartition } from '../../types/internal'
import type { AnyDocument } from '../../types/schema'
import { bytesToVectors, decodeVectorIndexParts } from '../../vector/vector-index/payload'
import type { DetachedIndex } from '../../workers/direct-executor'
import { indexMetadataOf } from '../durability-wiring'
import { insertDocumentVectors } from '../vector-coordinator'
import { loadStagedIndex } from './archive-restore'
import { earlierSnapshotFootprint, type RestoreFootprint, requireRestoreMemory } from './memory-budget'
import { installRestoredIndex, type RestoredIndex } from './replace'
import type { SnapshotEnvelope } from './restore-config'
import {
  type PreparedIndex,
  prepareDetachedIndex,
  prepareRestoredIndex,
  type RestoreDeps,
  restoredRegistryEntry,
} from './restore-setup'

type VectorsByDocument = Map<string, Map<string, Float32Array>>

function invalidSnapshot(message: string, details?: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, message, details)
}

async function decodeEarlierSnapshot(data: Uint8Array): Promise<SnapshotEnvelope> {
  const payloadBytes = await unpackIndexSnapshotEnvelope(data)
  let decoded: unknown
  try {
    decoded = decode(payloadBytes)
  } catch (err) {
    invalidSnapshot(`Snapshot data is not a Narsil snapshot: ${err instanceof Error ? err.message : String(err)}`, {
      bytes: data.length,
    })
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    invalidSnapshot('Snapshot data does not hold a snapshot envelope', { bytes: data.length })
  }
  const envelope = decoded as SnapshotEnvelope
  if (envelope.version !== 1 && envelope.version !== 2) {
    invalidSnapshot(`Unsupported snapshot version: ${envelope.version}. Expected version 1 or 2`, {
      version: envelope.version,
    })
  }
  if (!envelope.schema || typeof envelope.schema !== 'object')
    invalidSnapshot('Invalid snapshot: missing or invalid schema')
  if (!envelope.language || typeof envelope.language !== 'string') {
    invalidSnapshot('Invalid snapshot: missing or invalid language')
  }
  if (!Array.isArray(envelope.partitions)) invalidSnapshot('Invalid snapshot: missing partitions')
  return { ...envelope, vectorPromotion: raiseEarlierReleaseGraphSetting(envelope.vectorPromotion) }
}

function vectorsOfSnapshot(envelope: SnapshotEnvelope): VectorsByDocument {
  const byDocument: VectorsByDocument = new Map()
  for (const [fieldPath, rawParts] of Object.entries(envelope.vectorIndexes ?? {})) {
    for (const part of decodeVectorIndexParts(rawParts)) {
      const values = bytesToVectors(part.vectors)
      for (let i = 0; i < part.docIds.length; i++) {
        let fields = byDocument.get(part.docIds[i])
        if (fields === undefined) {
          fields = new Map()
          byDocument.set(part.docIds[i], fields)
        }
        fields.set(fieldPath, values.slice(i * part.dimension, (i + 1) * part.dimension))
      }
    }
  }
  return byDocument
}

function footprintOf(envelope: SnapshotEnvelope, prepared: PreparedIndex, deps: RestoreDeps): RestoreFootprint {
  let partitionBytes = 0
  for (const payload of envelope.partitions ?? []) partitionBytes += payload.byteLength
  const vectorCounts = new Map<string, number>()
  for (const [fieldPath, rawParts] of Object.entries(envelope.vectorIndexes ?? {})) {
    let count = 0
    for (const part of decodeVectorIndexParts(rawParts)) count += part.docIds.length
    vectorCounts.set(fieldPath, count)
  }
  return earlierSnapshotFootprint(prepared, partitionBytes, vectorCounts, deps.filesystemDurability)
}

function documentsOfPartition(envelope: SnapshotEnvelope, payload: Uint8Array): SerializablePartition['documents'] {
  return envelope.version === 2 ? documentsOfPayloadV2(payload).documents : deserializePayloadV1(payload).documents
}

function insertRestoredDocument(
  manager: PartitionManager,
  docId: string,
  fields: AnyDocument,
  vectors: Map<string, Float32Array> | undefined,
): void {
  manager.insert(docId, fields, { skipClone: true })
  if (vectors === undefined) return
  try {
    insertDocumentVectors(docId, vectors, manager.getVectorIndexes(), manager.partitionIdOf(docId))
  } catch (err) {
    manager.remove(docId)
    throw err
  }
}

function insertSnapshotDocuments(envelope: SnapshotEnvelope, manager: PartitionManager): void {
  const vectors = vectorsOfSnapshot(envelope)
  for (const payload of envelope.partitions ?? []) {
    for (const [docId, stored] of Object.entries(documentsOfPartition(envelope, payload))) {
      insertRestoredDocument(manager, docId, stored.fields as AnyDocument, vectors.get(docId))
    }
  }
  for (const vectorIndex of manager.getVectorIndexes().values()) vectorIndex.scheduleBuild()
}

async function stageBuiltIndex(
  indexName: string,
  prepared: PreparedIndex,
  built: DetachedIndex,
  staging: RestoreStaging,
  deps: RestoreDeps,
): Promise<RestoredIndex> {
  const entry = restoredRegistryEntry(prepared, built.manager, deps)
  const archive = await buildArchiveFromMemory({
    indexName,
    metadata: indexMetadataOf(indexName, entry, built.manager.partitionCount),
    manager: built.manager,
    vectorIndexes: built.manager.getVectorIndexes(),
    appliedSeqNo: () => 0,
    partitionId: null,
  })
  try {
    for (const ref of manifestFileRefs(archive.manifest))
      await staging.store.write(ref.key, [await archive.readFile(ref)])
  } finally {
    archive.release()
  }
  await validateStagedCheckpoint(staging.store, archive.manifest)
  return loadStagedIndex(indexName, { prepared, manifest: archive.manifest }, staging, staging.store, deps)
}

async function buildRestoredIndex(
  indexName: string,
  envelope: SnapshotEnvelope,
  prepared: PreparedIndex,
  staging: RestoreStaging | null,
  deps: RestoreDeps,
): Promise<RestoredIndex> {
  const built = prepareDetachedIndex(indexName, prepared, envelope.partitions?.length ?? 0, deps)
  try {
    insertSnapshotDocuments(envelope, built.manager)
    if (staging === null) return { prepared, detached: built, staging: null, checkpoint: [] }
    const restored = await stageBuiltIndex(indexName, prepared, built, staging, deps)
    deps.executor.discardDetachedIndex(built)
    return restored
  } catch (err) {
    deps.executor.discardDetachedIndex(built)
    throw err
  }
}

export async function restoreEarlierSnapshot(indexName: string, data: Uint8Array, deps: RestoreDeps): Promise<void> {
  const envelope = await decodeEarlierSnapshot(data)
  const prepared = prepareRestoredIndex(envelope, deps)
  requireRestoreMemory(indexName, footprintOf(envelope, prepared, deps))
  const analysedNow = { ...prepared, storedRevision: prepared.language.revision }
  const staging = deps.durability?.manager.stageRestore?.(indexName) ?? null
  try {
    await installRestoredIndex(
      indexName,
      await buildRestoredIndex(indexName, envelope, analysedNow, staging, deps),
      deps,
    )
  } finally {
    await staging?.discard().catch(() => undefined)
  }
}
