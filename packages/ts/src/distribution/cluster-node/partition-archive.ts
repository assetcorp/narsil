import { decode } from '@msgpack/msgpack'
import type { EngineCore } from '../../engine/core'
import { indexMetadataOf } from '../../engine/durability-metadata'
import { encodeIndexConfiguration } from '../../engine/snapshot/index-configuration'
import { emptySerializablePartition } from '../../engine/worker-resync'
import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import type { PartitionManager } from '../../partitioning/manager'
import { createByteReader } from '../../persistence/archive/byte-reader'
import { buildArchiveFromMemory } from '../../persistence/archive/from-memory'
import { memoryCheckpointStore } from '../../persistence/archive/memory-store'
import { readSnapshotArchive } from '../../persistence/archive/read'
import { archiveStream } from '../../persistence/archive/write'
import { loadPartitionSegments } from '../../persistence/durability/segment/load-partition'
import type { SegmentManifest } from '../../persistence/durability/segment/manifest'
import type { CheckpointStore } from '../../persistence/durability/segment/store'
import { readListedFile } from '../../persistence/durability/segment/store'
import { openChecksummedEnvelope } from '../../serialization/envelope-file'
import type { ByteSource } from '../../types/byte-source'
import type { IndexConfig } from '../../types/schema'
import { decodeVectorFilePayload } from '../../vector/vector-index/checkpoint-payload'
import { isDead } from '../../vector/vector-index/dead-bits'
import { bytesToVectors } from '../../vector/vector-index/payload'
import { MAX_PARTITION_COUNT } from '../constants'
import { ensureReplicationIndex, flattenSchema, requireSameFlatSchema } from './replication-index'

const VECTOR_FILE_ENVELOPE_VERSION = 2

export interface PartitionArchive {
  stream: ReadableStream<Uint8Array>
  lastSeqNo: number
}

export async function archiveReplicationPartition(
  core: EngineCore,
  indexName: string,
  partitionId: number,
  lastSeqNo: () => number,
): Promise<PartitionArchive> {
  core.guardShutdown()
  const release = await core.indexState.acquire(indexName, false)
  try {
    const entry = core.requireIndex(indexName)
    const manager = core.requireManager(indexName)
    let captured = 0
    const config = await encodeIndexConfiguration(entry)
    const checkpoint = await buildArchiveFromMemory({
      indexName,
      metadata: indexMetadataOf(indexName, entry, manager.partitionCount),
      manager,
      vectorIndexes: manager.getVectorIndexes(),
      appliedSeqNo: () => {
        captured = lastSeqNo()
        return captured
      },
      partitionId,
    })
    return { stream: archiveStream({ ...checkpoint, config, sourceIndexName: indexName }), lastSeqNo: captured }
  } finally {
    release()
  }
}

function restoreFailed(message: string, details: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, message, details)
}

function requireRestoreTarget(indexName: string, partitionId: number, partitionCount: number): void {
  if (!Number.isInteger(partitionId) || partitionId < 0) {
    restoreFailed('partitionId must be a non-negative integer', { indexName, partitionId })
  }
  if (!Number.isInteger(partitionCount) || partitionCount <= 0 || partitionCount > MAX_PARTITION_COUNT) {
    restoreFailed(`partitionCount must be an integer between 1 and ${MAX_PARTITION_COUNT}`, {
      indexName,
      partitionCount,
    })
  }
  if (partitionId >= partitionCount) {
    restoreFailed('partitionId is outside partitionCount', { indexName, partitionId, partitionCount })
  }
}

interface ReceivedArchive {
  language: string
  analysisRevision: string | null
  manifest: SegmentManifest
  store: CheckpointStore
}

async function receiveArchive(
  indexName: string,
  partitionId: number,
  source: ByteSource,
  schema: Record<string, string>,
): Promise<ReceivedArchive> {
  const store = memoryCheckpointStore()
  let language = ''
  let analysisRevision: string | null = null
  let received: SegmentManifest | null = null
  await readSnapshotArchive(createByteReader(source), {
    config: async bytes => {
      const { payload } = await openChecksummedEnvelope(bytes, {
        envelopeFormatVersion: 5,
        what: 'index configuration',
        allowsCompression: true,
      })
      const raw = decode(payload) as { language?: unknown; analysisRevision?: unknown }
      if (typeof raw.language !== 'string') restoreFailed('partition archive names no language', { indexName })
      language = raw.language
      analysisRevision = typeof raw.analysisRevision === 'string' ? raw.analysisRevision : null
    },
    manifest: async (manifest, sourceName) => {
      const listed = manifest.partitions.map(partition => partition.partitionId)
      if (listed.length !== 1 || listed[0] !== partitionId) {
        restoreFailed('partition archive lists other partitions', { indexName, partitionId, listed })
      }
      if (manifest.vectors.some(field => field.graphParts.length > 0)) {
        restoreFailed('partition archive holds a graph', { indexName, partitionId })
      }
      requireSameFlatSchema(indexName, schema, manifest.schema, 'partition snapshot')
      const rename = (key: string): string => `${indexName}/${key.slice(sourceName.length + 1)}`
      received = {
        ...manifest,
        partitions: manifest.partitions.map(partition => ({
          ...partition,
          segments: partition.segments.map(segment => ({ ...segment, key: rename(segment.key) })),
        })),
        vectors: manifest.vectors.map(field => ({
          ...field,
          files: field.files.map(file => ({ ...file, key: rename(file.key) })),
        })),
      }
    },
    file: async (name, _ref, bytes) => store.write(`${indexName}/${name}`, [bytes]),
  })
  if (received === null) restoreFailed('partition archive holds no manifest', { indexName, partitionId })
  return { language, analysisRevision, manifest: received, store }
}

async function replacePartition(
  manager: PartitionManager,
  partitionId: number,
  archive: ReceivedArchive,
): Promise<void> {
  const vectorIndexes = manager.getVectorIndexes()
  const held = [...manager.getPartition(partitionId).docIds()]
  for (const vectorIndex of vectorIndexes.values()) {
    for (const docId of held) if (vectorIndex.has(docId)) vectorIndex.remove(docId)
  }
  manager.deserializePartition(partitionId, emptySerializablePartition(manager, partitionId))
  const entry = archive.manifest.partitions[0]
  if (entry !== undefined) {
    await loadPartitionSegments(archive.store, entry, manager, {
      schema: archive.manifest.schema,
      decodesEveryDocument: true,
    })
  }
  for (const field of archive.manifest.vectors) {
    const vectorIndex = vectorIndexes.get(field.fieldPath)
    if (vectorIndex === undefined) continue
    for (const file of field.files) {
      const bytes = await readListedFile(archive.store, file.key, { bytes: file.bytes, what: 'vector file' })
      const { payload } = await openChecksummedEnvelope(bytes, {
        envelopeFormatVersion: VECTOR_FILE_ENVELOPE_VERSION,
        what: `vector file "${file.key}"`,
        allowsCompression: false,
      })
      const decoded = decodeVectorFilePayload(decode(payload))
      const vectors = bytesToVectors(decoded.vectors)
      for (let i = 0; i < decoded.docIds.length; i++) {
        if (isDead(file.dead, i)) continue
        const vector = vectors.slice(i * decoded.dimension, (i + 1) * decoded.dimension)
        vectorIndex.insert(decoded.docIds[i], vector, partitionId)
      }
    }
    vectorIndex.scheduleBuild()
  }
}

function recordReceivedAnalysis(core: EngineCore, indexName: string, receivedRevision: string | null): void {
  const entry = core.requireIndex(indexName)
  const current = entry.language.revision
  if (receivedRevision === current) return
  entry.analysisRevision =
    entry.analysisRevision === current || entry.analysisRevision === receivedRevision ? receivedRevision : null
  core.analysisRebuild.markStale({
    indexName,
    language: entry.language.name,
    storedRevision: entry.analysisRevision,
    currentRevision: current,
  })
}

export async function restoreReplicationPartition(
  core: EngineCore,
  engine: Narsil,
  indexName: string,
  partitionId: number,
  source: ByteSource,
  indexConfig: IndexConfig,
  partitionCount: number,
): Promise<void> {
  core.guardShutdown()
  requireRestoreTarget(indexName, partitionId, partitionCount)
  const archive = await receiveArchive(indexName, partitionId, source, flattenSchema(indexConfig.schema))
  let release = core.indexRegistry.has(indexName) ? await core.indexState.acquire(indexName, false) : null
  try {
    const restoreIndex = await ensureReplicationIndex(
      core,
      engine,
      indexName,
      indexConfig,
      archive.language,
      partitionCount,
    )
    if (release === null) release = await core.indexState.acquire(indexName, false)
    if (restoreIndex.created) {
      const synonyms = core.requireIndex(indexName).synonyms
      await core.orchestrator.replicateToWorkers({
        type: 'createIndex',
        indexName,
        config: restoreIndex.config,
        requestId: `replicate-partition-index-${indexName}`,
        ...(synonyms !== null ? { synonyms } : {}),
      })
    }
    const wasScaledOut = core.orchestrator.desyncIndex(indexName)
    try {
      await replacePartition(core.requireManager(indexName), partitionId, archive)
      recordReceivedAnalysis(core, indexName, archive.analysisRevision)
    } finally {
      await core.orchestrator.resyncIndex(indexName, wasScaledOut)
    }
  } finally {
    release?.()
  }
}
