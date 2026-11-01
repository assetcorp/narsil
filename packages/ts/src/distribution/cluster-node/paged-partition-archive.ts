import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import { isCompositePartition } from '../../core/partition/composite'
import { parseVectorDimension } from '../../core/partition/utils'
import type { PartitionManager } from '../../partitioning/manager'
import type { ArchiveCheckpoint } from '../../persistence/durability/archive-checkpoint'
import type { DurableDirectory } from '../../persistence/durability/durable-filesystem'
import { segmentsPrefix, vectorFileKey } from '../../persistence/durability/segment/layout'
import {
  encodeSegmentManifest,
  type FileRef,
  type SegmentManifest,
  type VectorFieldRef,
  type VectorFileRef,
} from '../../persistence/durability/segment/manifest'
import { directoryCheckpointStore } from '../../persistence/durability/segment/store'
import { readVectorFile, VECTOR_FILE_ENVELOPE_VERSION } from '../../persistence/durability/segment/vector-load'
import { decodeSections, loadFailed, RECORD_PAGE_BYTES, SEGMENT_PAGE_BYTES } from '../../persistence/paged/format'
import { crc32Final, crc32Init, crc32Update } from '../../serialization/crc32'
import { engineVersionParts } from '../../serialization/envelope-file'
import { HEADER_SIZE, RESERVED_SIZE, writeHeader } from '../../serialization/header'
import { VECTOR_FILE_PAYLOAD_VERSION } from '../../vector/vector-index/checkpoint-payload'
import { vectorsPerFile } from '../../vector/vector-index/checkpoint-plan'
import { isDead } from '../../vector/vector-index/dead-bits'
import { PARTITION_COPY_VECTOR_RUN_BYTES } from '../constants'

const FLOAT32_BYTES = 4
const BIN8 = 0xc4
const BIN16 = 0xc5
const BIN32 = 0xc6
const UINT8_MAX = 0xff
const UINT16_MAX = 0xffff
const FIXMAP_OF_SIX = 0x86
const VECTOR_FILE_PAGE_SIZES: ReadonlySet<number> = new Set([SEGMENT_PAGE_BYTES, RECORD_PAGE_BYTES])

function binHeader(length: number): Uint8Array {
  if (length <= UINT8_MAX) return Uint8Array.of(BIN8, length)
  if (length <= UINT16_MAX) return Uint8Array.of(BIN16, length >> 8, length & 0xff)
  const header = new Uint8Array(5)
  header[0] = BIN32
  new DataView(header.buffer).setUint32(1, length, false)
  return header
}

interface VectorSlot {
  docId: string
  ref: VectorFileRef
  position: number
}

async function docIdsOf(
  checkpoint: ArchiveCheckpoint,
  directory: DurableDirectory,
  ref: VectorFileRef,
  fieldPath: string,
): Promise<readonly string[]> {
  const { headOffset, headLength } = ref
  if (headOffset === undefined || headLength === undefined) {
    const { payload } = await readVectorFile(directoryCheckpointStore(directory), ref, fieldPath)
    return payload.docIds
  }
  const head = await checkpoint.readRange(ref, HEADER_SIZE + headOffset, headLength)
  const raw = decode(head) as { sections?: unknown }
  const sections = decodeSections(raw.sections, ref.bytes - HEADER_SIZE, `head of "${ref.key}"`, VECTOR_FILE_PAGE_SIZES)
  const section = sections.find(candidate => candidate.name === 'docIds')
  if (section === undefined) loadFailed(`The head of "${ref.key}" lists no section "docIds"`)
  const docIds = decode(await checkpoint.readRange(ref, HEADER_SIZE + section.offset, section.length))
  if (!Array.isArray(docIds) || docIds.length !== ref.count) {
    loadFailed(`The vector file "${ref.key}" lists the wrong number of IDs`)
  }
  return docIds as string[]
}

interface PartitionVectorFile {
  ref: VectorFileRef
  temporaryKey: string
}

async function writePartitionVectorFile(
  checkpoint: ArchiveCheckpoint,
  directory: DurableDirectory,
  target: { key: string; id: number; temporaryKey: string; fieldPath: string; dimension: number },
  slots: readonly VectorSlot[],
): Promise<PartitionVectorFile> {
  const { dimension, fieldPath, temporaryKey } = target
  const width = dimension * FLOAT32_BYTES
  const handle = await directory.appendHandle(temporaryKey)
  let state = crc32Init()
  let payloadLength = 0
  async function appendPayload(bytes: Uint8Array): Promise<void> {
    state = crc32Update(state, bytes)
    payloadLength += bytes.byteLength
    await handle.append(bytes)
  }
  try {
    await handle.append(new Uint8Array(HEADER_SIZE))
    await appendPayload(Uint8Array.of(FIXMAP_OF_SIX))
    for (const [key, value] of [
      ['v', VECTOR_FILE_PAYLOAD_VERSION],
      ['fieldName', fieldPath],
      ['dimension', dimension],
      ['docIds', slots.map(slot => slot.docId)],
      ['codes', null],
    ] as const) {
      await appendPayload(encode(key))
      await appendPayload(encode(value))
    }
    await appendPayload(encode('vectors'))
    await appendPayload(binHeader(slots.length * width))
    let at = 0
    while (at < slots.length) {
      const first = slots[at]
      let end = at + 1
      const limit = Math.max(1, Math.floor(PARTITION_COPY_VECTOR_RUN_BYTES / width))
      while (
        end < slots.length &&
        end - at < limit &&
        slots[end].ref === first.ref &&
        slots[end].position === first.position + (end - at)
      ) {
        end += 1
      }
      const offset = first.ref.bytes - (first.ref.count - first.position) * width
      await appendPayload(await checkpoint.readRange(first.ref, offset, (end - at) * width))
      at = end
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
  const checksum = crc32Final(state)
  const [major, minor, patch] = engineVersionParts()
  const header = writeHeader({
    magic: 'NRSL',
    envelopeFormatVersion: VECTOR_FILE_ENVELOPE_VERSION,
    engineVersionMajor: major,
    engineVersionMinor: minor,
    engineVersionPatch: patch,
    payloadLength,
    flags: {
      compressionEnabled: false,
      compressionAlgorithm: 'none',
      checksumPresent: true,
      encryptionEnabled: false,
    },
    checksum,
    reserved: new Uint8Array(RESERVED_SIZE),
  })
  const patched = await directory.markerHandle(temporaryKey)
  try {
    await patched.writeSlot(0, header)
  } finally {
    await patched.close()
  }
  return {
    temporaryKey,
    ref: {
      id: target.id,
      key: target.key,
      count: slots.length,
      dead: null,
      bytes: HEADER_SIZE + payloadLength,
      checksum,
    },
  }
}

async function partitionField(
  checkpoint: ArchiveCheckpoint,
  directory: DurableDirectory,
  scope: { indexName: string; manifest: SegmentManifest; temporaryPrefix: string; holds(docId: string): boolean },
  field: VectorFieldRef,
  written: Map<string, string>,
): Promise<VectorFieldRef> {
  const fieldType = scope.manifest.schema[field.fieldPath]
  const dimension = fieldType === undefined ? null : parseVectorDimension(fieldType)
  if (dimension === null) loadFailed(`The manifest gives vector field "${field.fieldPath}" no dimension`)
  const capacity = vectorsPerFile(dimension, null)
  const files: VectorFileRef[] = []
  let pending: VectorSlot[] = []

  async function flush(): Promise<void> {
    if (pending.length === 0) return
    const id = files.length
    const key = vectorFileKey(scope.indexName, field.fieldPath, id)
    const temporaryKey = `${scope.temporaryPrefix}${written.size}`
    const file = await writePartitionVectorFile(
      checkpoint,
      directory,
      { key, id, temporaryKey, fieldPath: field.fieldPath, dimension: dimension as number },
      pending,
    )
    files.push(file.ref)
    written.set(key, temporaryKey)
    pending = []
  }

  for (const ref of field.files) {
    const docIds = await docIdsOf(checkpoint, directory, ref, field.fieldPath)
    for (let position = 0; position < docIds.length; position++) {
      if (isDead(ref.dead, position) || !scope.holds(docIds[position])) continue
      pending.push({ docId: docIds[position], ref, position })
      if (pending.length === capacity) await flush()
    }
  }
  await flush()
  return { fieldPath: field.fieldPath, nextFileId: files.length, files, graphGeneration: 0, graphParts: [] }
}

export interface PagedPartitionCheckpoint extends ArchiveCheckpoint {
  lastSeqNo: number
}

export async function openPagedPartitionArchive(
  checkpoint: ArchiveCheckpoint,
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
  manager: PartitionManager,
): Promise<PagedPartitionCheckpoint> {
  const { manifest } = checkpoint
  const temporaryPrefix = `${segmentsPrefix(indexName)}partition-copy-${partitionId}-${generateId()}-`
  const written = new Map<string, string>()
  const partition = manager.getPartition(partitionId)

  async function removeWritten(): Promise<void> {
    for (const temporaryKey of written.values()) await directory.remove(temporaryKey)
  }

  try {
    const vectors: VectorFieldRef[] = []
    for (const field of manifest.vectors) {
      vectors.push(
        await partitionField(
          checkpoint,
          directory,
          { indexName, manifest, temporaryPrefix, holds: docId => partition.has(docId) },
          field,
          written,
        ),
      )
    }
    const narrowed: SegmentManifest = {
      ...manifest,
      partitions: manifest.partitions.filter(entry => entry.partitionId === partitionId),
      checkpoint: manifest.checkpoint.filter(entry => entry.partitionId === partitionId),
      vectors,
    }
    const encoded = await encodeSegmentManifest(narrowed)
    let manifestLength = 0
    for (const chunk of encoded.chunks) manifestLength += chunk.byteLength
    const manifestBytes = new Uint8Array(manifestLength)
    let cursor = 0
    for (const chunk of encoded.chunks) {
      manifestBytes.set(chunk, cursor)
      cursor += chunk.byteLength
    }
    const { readRange } = directory
    return {
      manifestBytes,
      manifest: narrowed,
      lastSeqNo: narrowed.checkpoint[0]?.lastSeqNo ?? 0,
      directory,
      readFile: (ref: FileRef) => checkpoint.readFile(ref),
      readRange: (ref, offset, length) => {
        const temporaryKey = written.get(ref.key)
        if (temporaryKey === undefined || readRange === undefined) return checkpoint.readRange(ref, offset, length)
        return readRange.call(directory, temporaryKey, offset, length)
      },
      release: () => {
        void removeWritten()
          .catch(() => undefined)
          .finally(() => checkpoint.release())
      },
    }
  } catch (error) {
    await removeWritten().catch(() => undefined)
    throw error
  }
}

export async function removeReceivedFilesNothingReads(
  directory: DurableDirectory,
  manager: PartitionManager,
  partitionId: number,
  currentPrefix: string,
): Promise<void> {
  const partition = manager.getPartition(partitionId)
  const read = new Set<string>()
  if (isCompositePartition(partition)) {
    for (const segment of partition.frozenSegments()) {
      if (segment.paged !== null) read.add(segment.paged.key)
    }
  }
  const everyReceipt = `${manager.indexName}/received/p${partitionId}/`
  for (const key of await directory.list(everyReceipt)) {
    if (read.has(key)) continue
    if (key.startsWith(currentPrefix) && [...read].some(held => held.startsWith(currentPrefix))) continue
    await directory.remove(key)
  }
}
