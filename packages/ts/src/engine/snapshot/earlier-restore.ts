import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import { setNestedValue } from '../../partitioning/manager/nested-values'
import { raiseEarlierReleaseGraphSetting } from '../../schema/validator'
import { unpackIndexSnapshotEnvelope } from '../../serialization/envelope'
import { deserializePayloadV1 } from '../../serialization/payload-v1'
import { documentsOfPayloadV2 } from '../../serialization/payload-v2'
import type { SerializablePartition } from '../../types/internal'
import type { AnyDocument } from '../../types/schema'
import { bytesToVectors, decodeVectorIndexParts } from '../../vector/vector-index/payload'
import { BATCH_CHUNK_SIZE } from '../constants'
import type { DurableMutation } from '../durability-integration'
import { insertDocumentVectors } from '../vector-coordinator'
import type { SnapshotEnvelope } from './restore-config'
import {
  abandonRestoredIndex,
  createRestoredIndex,
  prepareRestoredIndex,
  type RestoreDeps,
  recordRestoredCounts,
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

function documentsOfPartition(envelope: SnapshotEnvelope, payload: Uint8Array): SerializablePartition['documents'] {
  return envelope.version === 2 ? documentsOfPayloadV2(payload).documents : deserializePayloadV1(payload).documents
}

function withVectors(fields: AnyDocument, vectors: Map<string, Float32Array> | undefined): AnyDocument {
  if (vectors === undefined || vectors.size === 0) return fields
  const nested = [...vectors.keys()].some(fieldPath => fieldPath.includes('.'))
  const document = nested ? structuredClone(fields) : { ...fields }
  for (const [fieldPath, vector] of vectors) setNestedValue(document, fieldPath, vector)
  return document
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

async function insertRestoredChunk(
  indexName: string,
  manager: PartitionManager,
  chunk: readonly [string, AnyDocument][],
  vectors: VectorsByDocument,
  deps: RestoreDeps,
): Promise<void> {
  if (deps.durability === null) {
    for (const [docId, fields] of chunk) insertRestoredDocument(manager, docId, fields, vectors.get(docId))
    return
  }
  const mutations: DurableMutation[] = chunk.map(([docId, fields]) => ({
    docId,
    document: withVectors(fields, vectors.get(docId)),
    apply: () => insertRestoredDocument(manager, docId, fields, vectors.get(docId)),
  }))
  for (const outcome of await deps.durability.recordMutationBatch(indexName, mutations)) {
    if (!outcome.ok) throw outcome.error
  }
}

async function insertSnapshotDocuments(
  indexName: string,
  envelope: SnapshotEnvelope,
  manager: PartitionManager,
  deps: RestoreDeps,
): Promise<void> {
  const vectors = vectorsOfSnapshot(envelope)
  for (const payload of envelope.partitions ?? []) {
    const documents = Object.entries(documentsOfPartition(envelope, payload)).map(
      ([docId, stored]) => [docId, stored.fields as AnyDocument] as [string, AnyDocument],
    )
    for (let start = 0; start < documents.length; start += BATCH_CHUNK_SIZE) {
      await insertRestoredChunk(indexName, manager, documents.slice(start, start + BATCH_CHUNK_SIZE), vectors, deps)
    }
  }
  for (const vectorIndex of manager.getVectorIndexes().values()) vectorIndex.scheduleBuild()
}

export async function restoreEarlierSnapshot(indexName: string, data: Uint8Array, deps: RestoreDeps): Promise<void> {
  const envelope = await decodeEarlierSnapshot(data)
  const prepared = prepareRestoredIndex(envelope, deps)
  const analysedNow = { ...prepared, storedRevision: prepared.language.revision }
  const partitionCount = envelope.partitions?.length ?? 0
  const { manager, release } = await createRestoredIndex(indexName, analysedNow, partitionCount, deps)
  try {
    await insertSnapshotDocuments(indexName, envelope, manager, deps)
    recordRestoredCounts(indexName, manager, deps)
    if (deps.durability) {
      await deps.durability.manager.persistMetadata(indexName)
      await deps.durability.manager.checkpoint(indexName)
    }
    await deps.announceIndexCreated(indexName, prepared.config)
  } catch (err) {
    await abandonRestoredIndex(indexName, deps)
    throw err
  } finally {
    release()
  }
}
