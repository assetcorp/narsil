import { decode } from '@msgpack/msgpack'
import { decodeStoredDocument } from '../../core/partition/frozen/document-source'
import { setNestedValue } from '../../distribution/replication/replica'
import type { ArchiveCheckpoint } from '../../persistence/durability/archive-checkpoint'
import type { PartitionManifestEntry, VectorFileRef } from '../../persistence/durability/segment/manifest'
import type { SegmentScan } from '../../persistence/paged/segment-scan'
import { openChecksummedEnvelope } from '../../serialization/envelope-file'
import { decodeKeywordSegment } from '../../serialization/keyword-segment/decode'
import {
  KEYWORD_SEGMENT_ENVELOPE_VERSION,
  type KeywordSegmentContents,
} from '../../serialization/keyword-segment/types'
import { decodeVectorFilePayload } from '../../vector/vector-index/checkpoint-payload'
import { isDead } from '../../vector/vector-index/dead-bits'
import { bytesToVectors } from '../../vector/vector-index/payload'
import { EXPORT_CHUNK_BYTES } from '../constants'
import { DOCUMENT_EXPORT_FORMAT, DOCUMENT_EXPORT_VERSION } from './import'
import { encodeDocumentJson, encodeExactJson } from './json-line'
import type { VectorReads } from './paged-lines'

const VECTOR_FILE_ENVELOPE_VERSION = 2
const FLOAT32_BYTES = 4
const ENVELOPE_VERSION_OFFSET = 4

interface VectorLocation {
  ref: VectorFileRef
  position: number
  dimension: number
}

type VectorLocations = Map<string, Map<string, VectorLocation>>

async function locateVectors(checkpoint: ArchiveCheckpoint): Promise<VectorLocations> {
  const located: VectorLocations = new Map()
  for (const field of checkpoint.manifest.vectors) {
    const byDocId = new Map<string, VectorLocation>()
    for (const ref of field.files) {
      const { payload } = await openChecksummedEnvelope(await checkpoint.readFile(ref), {
        envelopeFormatVersion: VECTOR_FILE_ENVELOPE_VERSION,
        what: `vector file "${ref.key}"`,
        allowsCompression: false,
      })
      const decoded = decodeVectorFilePayload(decode(payload))
      for (let position = 0; position < decoded.docIds.length; position++) {
        if (isDead(ref.dead, position)) continue
        byDocId.set(decoded.docIds[position], { ref, position, dimension: decoded.dimension })
      }
    }
    located.set(field.fieldPath, byDocId)
  }
  return located
}

async function readVector(checkpoint: ArchiveCheckpoint, location: VectorLocation): Promise<number[]> {
  const width = location.dimension * FLOAT32_BYTES
  const offset = location.ref.bytes - (location.ref.count - location.position) * width
  return Array.from(bytesToVectors((await checkpoint.readRange(location.ref, offset, width)).slice()))
}

async function readSegment(checkpoint: ArchiveCheckpoint, ref: PartitionManifestEntry['segments'][number]) {
  const { payload } = await openChecksummedEnvelope(await checkpoint.readFile(ref), {
    envelopeFormatVersion: KEYWORD_SEGMENT_ENVELOPE_VERSION,
    what: `segment "${ref.key}"`,
    allowsCompression: true,
  })
  return decodeKeywordSegment(payload, false)
}

const decoder = new TextDecoder()

function idAt(contents: KeywordSegmentContents, ordinal: number): string {
  const ids = contents.arrays.idTable
  return decoder.decode(ids.blob.subarray(ids.offsets[ordinal], ids.offsets[ordinal + 1]))
}

async function winnersOf(
  checkpoint: ArchiveCheckpoint,
  partition: PartitionManifestEntry,
): Promise<Map<string, number>> {
  const winners = new Map<string, number>()
  for (let at = 0; at < partition.segments.length; at++) {
    const contents = await readSegment(checkpoint, partition.segments[at])
    for (const docId of contents.tombstones) winners.delete(docId)
    for (let ordinal = 0; ordinal < contents.arrays.documentCount; ordinal++) winners.set(idAt(contents, ordinal), at)
  }
  return winners
}

async function wholeSegmentScan(
  checkpoint: ArchiveCheckpoint,
  ref: PartitionManifestEntry['segments'][number],
): Promise<SegmentScan> {
  const contents = await readSegment(checkpoint, ref)
  const table = contents.arrays.documentTable
  const ids = new Set<string>()
  for (let ordinal = 0; ordinal < contents.arrays.documentCount; ordinal++) ids.add(idAt(contents, ordinal))
  return {
    count: contents.arrays.documentCount,
    schema: contents.schema,
    tombstones: new Set(contents.tombstones),
    idAt: ordinal => idAt(contents, ordinal),
    holds: docId => ids.has(docId),
    storedDocumentAt: ordinal =>
      decodeStoredDocument(
        table.blob.subarray(table.offsets[ordinal], table.offsets[ordinal + 1]),
        table.discardedFields,
      ) as Record<string, unknown>,
    close: () => undefined,
  }
}

async function wholeFileVectorReads(checkpoint: ArchiveCheckpoint): Promise<VectorReads> {
  const located = await locateVectors(checkpoint)
  return {
    async vectorOf(fieldPath, docId) {
      const location = located.get(fieldPath)?.get(docId)
      return location === undefined ? null : readVector(checkpoint, location)
    },
    close: () => located.clear(),
  }
}

async function* pagedDocumentLines(checkpoint: ArchiveCheckpoint): AsyncGenerator<string> {
  const { openFileVectorReads, pagedPartitionLines } = await import('../../persistence/paged/module')
  const vectors = await openFileVectorReads(checkpoint, () => wholeFileVectorReads(checkpoint))
  try {
    for (const partition of checkpoint.manifest.partitions) {
      yield* pagedPartitionLines(checkpoint, partition, vectors, ref => wholeSegmentScan(checkpoint, ref))
    }
  } finally {
    vectors.close()
  }
}

async function anyPartitionIsPaged(checkpoint: ArchiveCheckpoint): Promise<boolean> {
  for (const partition of checkpoint.manifest.partitions) {
    for (const ref of partition.segments) {
      const [version] = await checkpoint.readRange(ref, ENVELOPE_VERSION_OFFSET, 1)
      if (version !== KEYWORD_SEGMENT_ENVELOPE_VERSION) return true
    }
  }
  return false
}

async function* documentLines(checkpoint: ArchiveCheckpoint): AsyncGenerator<string> {
  if (await anyPartitionIsPaged(checkpoint)) {
    yield* pagedDocumentLines(checkpoint)
    return
  }
  const vectors = await locateVectors(checkpoint)
  for (const partition of checkpoint.manifest.partitions) {
    const winners = await winnersOf(checkpoint, partition)
    for (let at = 0; at < partition.segments.length; at++) {
      const contents = await readSegment(checkpoint, partition.segments[at])
      const table = contents.arrays.documentTable
      for (let ordinal = 0; ordinal < contents.arrays.documentCount; ordinal++) {
        const docId = idAt(contents, ordinal)
        if (winners.get(docId) !== at) continue
        const stored = decodeStoredDocument(
          table.blob.subarray(table.offsets[ordinal], table.offsets[ordinal + 1]),
          table.discardedFields,
        ) as Record<string, unknown>
        const document: Record<string, unknown> = { id: docId, ...stored }
        document.id = docId
        for (const [fieldPath, located] of vectors) {
          const location = located.get(docId)
          if (location !== undefined) setNestedValue(document, fieldPath, await readVector(checkpoint, location))
        }
        yield `${encodeDocumentJson(document, docId)}\n`
      }
    }
  }
}

async function* exportLines(header: Record<string, unknown>, checkpoint: ArchiveCheckpoint): AsyncGenerator<string> {
  yield `${encodeExactJson({ format: DOCUMENT_EXPORT_FORMAT, version: DOCUMENT_EXPORT_VERSION, index: header }, '')}\n`
  yield* documentLines(checkpoint)
}

export function documentExportStream(
  header: Record<string, unknown>,
  checkpoint: ArchiveCheckpoint,
): ReadableStream<Uint8Array> {
  const lines = exportLines(header, checkpoint)
  const encoder = new TextEncoder()
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    checkpoint.release()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let text = ''
        while (text.length < EXPORT_CHUNK_BYTES) {
          const step = await lines.next()
          if (step.done) {
            if (text.length > 0) controller.enqueue(encoder.encode(text))
            release()
            controller.close()
            return
          }
          text += step.value
        }
        controller.enqueue(encoder.encode(text))
      } catch (error) {
        release()
        controller.error(error)
      }
    },
    async cancel() {
      release()
      await lines.return(undefined)
    },
  })
}
