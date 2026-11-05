import { sourceIndexNameOf } from '../../../ts/src/persistence/archive/read'
import { archiveStream } from '../../../ts/src/persistence/archive/write'
import { decodeManifestPayload } from '../../../ts/src/persistence/durability/segment/manifest-decode'
import { type Decoded, FormError } from '../forms/decoded'
import type { JsonObject } from '../forms/json'
import type { SampleKind } from '../forms/kinds'
import { plainOf } from './context'
import { joined } from './envelope'
import {
  listAt,
  manifestBytesOf,
  manifestPayloadFromJson,
  objectAt,
  writeBackupManifest,
  writeIndexConfiguration,
  writeIndexMetadata,
  writeKeywordSegment,
  writeManifest,
} from './write-envelopes'
import { writeCommitMarker, writeDocumentExport, writeLogSegment } from './write-logs'
import { writePagedSegmentFile } from './write-paged'
import { type WrittenFile, writeGraphPart, writeVectorFile } from './write-vectors'

const HEADER_CHECKSUM_OFFSET = 14
const GRAPH_PART_ENTRY = /^segments\/vec-.+-graph-g\d+-p\d{16}$/
const VECTOR_FILE_ENTRY = /^segments\/vec-.+-f\d{16}$/
const SEGMENT_ENTRY = /^segments\/\d+\/s\d{16}$/

async function writeArchiveEntry(name: string, content: JsonObject, what: string): Promise<WrittenFile> {
  if (GRAPH_PART_ENTRY.test(name)) return writeGraphPart(content, what)
  if (VECTOR_FILE_ENTRY.test(name)) return writeVectorFile(content, what)
  if (!SEGMENT_ENTRY.test(name)) throw new FormError(`${what} is not a file that an archive lists`)
  const bytes =
    content.head === undefined ? await writeKeywordSegment(content, what) : await writePagedSegmentFile(content, what)
  return { bytes }
}

function headerChecksumOf(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(HEADER_CHECKSUM_OFFSET, false)
}

function refsOf(payload: Map<string, Decoded>): Map<string, Decoded>[] {
  const refs: Map<string, Decoded>[] = []
  const collect = (list: Decoded | undefined, key: string) => {
    if (!Array.isArray(list)) return
    for (const entry of list) {
      const inner = entry instanceof Map ? entry.get(key) : undefined
      if (!Array.isArray(inner)) continue
      for (const ref of inner) if (ref instanceof Map) refs.push(ref)
    }
  }
  collect(payload.get('partitions'), 'segments')
  collect(payload.get('vectors'), 'files')
  collect(payload.get('vectors'), 'graphParts')
  return refs
}

async function bytesOfStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return joined(chunks)
    chunks.push(value)
  }
}

export async function writeSnapshotArchive(json: JsonObject, what: string): Promise<Uint8Array> {
  const [configEntry, manifestEntry, ...fileEntries] = listAt(json.entries, `${what}.entries`).map((entry, at) =>
    objectAt(entry, `${what}.entries[${at}]`),
  )
  if (configEntry?.name !== 'config' || manifestEntry?.name !== 'manifest') {
    throw new FormError(`${what} must begin with its config and manifest entries`)
  }
  const config = await writeIndexConfiguration(objectAt(configEntry.content, `${what} config`), `${what} config`)
  const manifestJson = objectAt(manifestEntry.content, `${what} manifest`)
  const payload = manifestPayloadFromJson(manifestJson.payload, `${what} manifest payload`)
  const refs = refsOf(payload)
  const keys = refs.map(ref => String(ref.get('key')))
  const indexName = sourceIndexNameOf(keys)
  const written = new Map<string, Uint8Array>()
  for (const entry of fileEntries) {
    const name = String(entry.name)
    const file = await writeArchiveEntry(name, objectAt(entry.content, `${what} ${name}`), `${what} ${name}`)
    const ref = refs.find(candidate => candidate.get('key') === `${indexName}/${name}`)
    if (ref === undefined) throw new FormError(`${what} holds ${name}, which its manifest does not list`)
    ref.set('bytes', file.bytes.byteLength)
    ref.set('checksum', headerChecksumOf(file.bytes))
    if (file.headOffset !== undefined && file.headLength !== undefined && file.headChecksum !== undefined) {
      ref.set('headOffset', file.headOffset)
      ref.set('headLength', file.headLength)
      ref.set('headChecksum', file.headChecksum)
    }
    written.set(`${indexName}/${name}`, file.bytes)
  }
  const manifestBytes = await manifestBytesOf(payload, manifestJson, `${what} manifest`)
  const decoded = decodeManifestPayload(plainOf(payload, what) as Record<string, unknown>, indexName)
  if (decoded.kind !== 'current') throw new FormError(`${what} manifest is not a current manifest`)
  return bytesOfStream(
    archiveStream({
      config,
      manifestBytes,
      manifest: decoded.manifest,
      sourceIndexName: indexName,
      readRange: async (ref, offset, length) => {
        const bytes = written.get(ref.key)
        if (bytes === undefined) throw new FormError(`${what} lists ${ref.key}, which it does not hold`)
        return bytes.subarray(offset, offset + length)
      },
      release: () => undefined,
    }),
  )
}

export async function writeSample(kind: SampleKind, json: JsonObject, what: string): Promise<Uint8Array> {
  switch (kind) {
    case 'log-segment':
      return writeLogSegment(json, what)
    case 'commit-marker':
      return writeCommitMarker(json, what)
    case 'manifest':
      return writeManifest(json, what)
    case 'keyword-segment':
      return writeKeywordSegment(json, what)
    case 'paged-segment':
      return writePagedSegmentFile(json, what)
    case 'vector-file':
      return (await writeVectorFile(json, what)).bytes
    case 'graph-part':
      return (await writeGraphPart(json, what)).bytes
    case 'index-metadata':
      return writeIndexMetadata(json, what)
    case 'index-configuration':
      return writeIndexConfiguration(json, what)
    case 'backup-manifest':
      return writeBackupManifest(json, what)
    case 'snapshot-archive':
      return writeSnapshotArchive(json, what)
    case 'document-export':
      return writeDocumentExport(json, what)
  }
}
