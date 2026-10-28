import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import { type ByteSource, createByteReader } from '../../persistence/archive/byte-reader'
import { buildArchiveFromMemory } from '../../persistence/archive/from-memory'
import { archiveStream } from '../../persistence/archive/write'
import type { ArchiveCheckpoint } from '../../persistence/durability/archive-checkpoint'
import { MAX_FILE_BYTES } from '../../serialization/constants'
import { HEADER_SIZE, hasNrslMagic, readHeader } from '../../serialization/header'
import type { IndexRegistryEntry } from '../core'
import type { DurabilityIntegration } from '../durability-integration'
import { indexMetadataOf } from '../durability-metadata'
import { restoreArchive } from './archive-restore'
import { restoreEarlierSnapshot } from './earlier-restore'
import { encodeIndexConfiguration } from './index-configuration'
import type { RestoreDeps } from './restore-setup'

export type { RestoreDeps } from './restore-setup'

const NRSL_MAGIC_BYTES = 4

export interface SnapshotDeps {
  indexName: string
  manager: PartitionManager
  entry: IndexRegistryEntry
  durability: DurabilityIntegration | null
}

export async function checkpointForArchive(deps: SnapshotDeps): Promise<ArchiveCheckpoint> {
  const durable = deps.durability?.manager
  if (durable?.openArchiveCheckpoint !== undefined) return durable.openArchiveCheckpoint(deps.indexName)
  return buildArchiveFromMemory({
    indexName: deps.indexName,
    metadata: indexMetadataOf(deps.indexName, deps.entry, deps.manager.partitionCount),
    manager: deps.manager,
    vectorIndexes: deps.manager.getVectorIndexes(),
    appliedSeqNo: partitionId => durable?.highestPersistedSeqNo(deps.indexName, partitionId) ?? 0,
    partitionId: null,
  })
}

export async function createSnapshot(deps: SnapshotDeps): Promise<ReadableStream<Uint8Array>> {
  const config = await encodeIndexConfiguration(deps.entry)
  const checkpoint = await checkpointForArchive(deps)
  return archiveStream({ ...checkpoint, config, sourceIndexName: deps.indexName })
}

function requireSnapshotSource(data: unknown): ByteSource {
  if (data instanceof Uint8Array) return data
  if (data !== null && typeof data === 'object') {
    if (typeof (data as ReadableStream).getReader === 'function') return data as ReadableStream<Uint8Array>
    if (typeof (data as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
      return data as AsyncIterable<Uint8Array>
    }
  }
  throw new NarsilError(
    ErrorCodes.DOC_VALIDATION_FAILED,
    'Snapshot data must be a Uint8Array, a ReadableStream of bytes, or an async iterable of bytes',
  )
}

async function readEarlierSnapshotFile(reader: ReturnType<typeof createByteReader>): Promise<Uint8Array> {
  const length = HEADER_SIZE + readHeader(await reader.peek(HEADER_SIZE)).payloadLength
  if (length > MAX_FILE_BYTES) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `The snapshot declares ${length} bytes, above the file size limit of ${MAX_FILE_BYTES}`,
      { bytes: length },
    )
  }
  const bytes = (await reader.readExactly(length)) ?? new Uint8Array(0)
  if (bytes.byteLength < length) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      'The snapshot ends before the payload its header declares',
    )
  }
  const trailing = await reader.readExactly(1)
  if (trailing !== null && trailing.byteLength > 0) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      'The snapshot holds bytes after the payload its header declares',
    )
  }
  return bytes
}

export async function restoreFromSnapshot(indexName: string, data: unknown, deps: RestoreDeps): Promise<void> {
  const reader = createByteReader(requireSnapshotSource(data))
  const head = await reader.peek(NRSL_MAGIC_BYTES)
  if (head.byteLength >= NRSL_MAGIC_BYTES && hasNrslMagic(head)) {
    let bytes: Uint8Array
    try {
      bytes = await readEarlierSnapshotFile(reader)
    } finally {
      await reader.close()
    }
    await restoreEarlierSnapshot(indexName, bytes, deps)
    return
  }
  if (head.byteLength === 0) {
    await reader.close()
    throw new NarsilError(ErrorCodes.DOC_VALIDATION_FAILED, 'Snapshot data is empty')
  }
  await restoreArchive(indexName, reader, deps)
}
