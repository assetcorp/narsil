import { createHash } from 'node:crypto'
import { FormError } from '../forms/decoded'
import { isJsonObject, type Json, type JsonObject } from '../forms/json'

const CLUSTER_PRIMARY_TERM = 1
const FIRST_SEQ_NO = 1
const BACKUP_ENVELOPE_VERSION = 1
const BACKUP_STARTED_AT_MS = 1_793_664_000_000
const BACKUP_TOOK_MS = 4_000
const SAMPLE_CLUSTER_UUID = '6f1c2a4e-3b5d-4e8f-9a1b-2c3d4e5f6a7b'

function objectIn(value: Json | undefined, what: string): JsonObject {
  if (!isJsonObject(value)) throw new FormError(`${what} is not an object`)
  return value
}

function listIn(value: Json | undefined, what: string): Json[] {
  if (!Array.isArray(value)) throw new FormError(`${what} is not a list`)
  return value
}

function countIn(value: Json | undefined, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new FormError(`${what} is not a count`)
  return value
}

export function copyOf(json: JsonObject): JsonObject {
  return structuredClone(json)
}

export function gzipped(json: JsonObject): JsonObject {
  const copy = copyOf(json)
  copy.header = { ...objectIn(copy.header, 'header'), compression: 'gzip' }
  return copy
}

export function withWriteRecords(records: JsonObject, firstSeqNo: number): JsonObject {
  const copy = copyOf(records)
  const count = countIn(objectIn(copy.head ?? copy.payload, 'payload').documentCount, 'documentCount')
  const seqNos = Array.from({ length: count }, (_, at) => firstSeqNo + at)
  const primaryTerms: Json[] = seqNos.map(() => CLUSTER_PRIMARY_TERM)
  if (copy.head !== undefined) {
    copy.sections = { ...objectIn(copy.sections, 'sections'), seqNos, primaryTerms }
  } else {
    copy.payload = { ...objectIn(copy.payload, 'payload'), seqNos, primaryTerms }
  }
  return copy
}

export function documentCountOf(segment: JsonObject): number {
  return countIn(objectIn(segment.head ?? segment.payload, 'payload').documentCount, 'documentCount')
}

export function withTermHistory(manifest: JsonObject): JsonObject {
  const copy = copyOf(manifest)
  const payload = objectIn(copy.payload, 'payload')
  payload.checkpoint = listIn(payload.checkpoint, 'checkpoint').map((entry, at) => ({
    ...objectIn(entry, `checkpoint[${at}]`),
    termHistory: [{ primaryTerm: CLUSTER_PRIMARY_TERM, firstSeqNo: FIRST_SEQ_NO }],
  }))
  return copy
}

export function partitionArchiveOf(archive: JsonObject): JsonObject {
  const copy = copyOf(archive)
  const entries = listIn(copy.entries, 'entries').map((entry, at) => objectIn(entry, `entries[${at}]`))
  const kept: JsonObject[] = []
  let nextSeqNo = FIRST_SEQ_NO
  for (const entry of entries) {
    const name = String(entry.name)
    if (/-graph-g\d+-p\d{16}$/.test(name)) continue
    if (name === 'manifest') {
      const manifest = withTermHistory(objectIn(entry.content, 'manifest'))
      const payload = objectIn(manifest.payload, 'manifest payload')
      payload.vectors = listIn(payload.vectors, 'vectors').map(field => ({
        ...objectIn(field, 'vector field'),
        graphParts: [],
      }))
      kept.push({ name, content: manifest })
      continue
    }
    if (/^segments\/\d+\/s\d{16}$/.test(name)) {
      const segment = objectIn(entry.content, name)
      kept.push({ name, content: withWriteRecords(segment, nextSeqNo) })
      nextSeqNo += documentCountOf(segment)
      continue
    }
    kept.push(entry)
  }
  copy.entries = kept
  return copy
}

export interface StoredSampleFile {
  key: string
  bytes: Uint8Array
}

function storedFile(bytes: Uint8Array): JsonObject {
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength }
}

export function backupManifestOf(
  indexName: string,
  lastSeqNo: number,
  config: Uint8Array,
  manifest: Uint8Array,
  files: readonly StoredSampleFile[],
): JsonObject {
  return {
    header: { envelopeFormatVersion: BACKUP_ENVELOPE_VERSION, compression: 'none', checksum: true },
    payload: {
      name: 'conformance',
      clusterUuid: SAMPLE_CLUSTER_UUID,
      indexName,
      startedAt: BACKUP_STARTED_AT_MS,
      completedAt: BACKUP_STARTED_AT_MS + BACKUP_TOOK_MS,
      partitionCount: 1,
      replicationFactor: 1,
      constraints: { zoneAwareness: false, zoneAttribute: 'zone', maxShardsPerNode: null },
      config: storedFile(config),
      partitions: [
        {
          partitionId: 0,
          lastSeqNo,
          manifest: storedFile(manifest),
          files: files.map(file => ({ key: file.key, ...storedFile(file.bytes) })),
        },
      ],
    },
  }
}
