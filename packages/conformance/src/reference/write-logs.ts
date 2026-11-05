import { buildEntry } from '../../../ts/src/distribution/replication/entry-checksum'
import type { ReplicationOperation } from '../../../ts/src/distribution/replication/types'
import { encodeDocumentJson, encodeExactJson } from '../../../ts/src/engine/export/json-line'
import { untagDocumentLine } from '../../../ts/src/engine/export/tags'
import { COMMIT_MARKER_SLOT_SIZE, encodeMarkerSlot } from '../../../ts/src/persistence/durability/commit-marker'
import { frameRecord, readDurableRegion, writeSegmentHeader } from '../../../ts/src/persistence/durability/wal-framing'
import { encodeDocument } from '../../../ts/src/serialization/document-encoding'
import { FormError } from '../forms/decoded'
import { type Json, type JsonObject, untagged } from '../forms/json'
import { numberFromJson } from '../forms/numbers'
import { plainOf } from './context'
import { joined } from './envelope'
import { listAt, objectAt } from './write-envelopes'

const WAL_FORMAT_VERSION_OFFSET = 4
const UTF8 = new TextEncoder()

function stringAt(value: Json | undefined, what: string): string {
  if (typeof value !== 'string') throw new FormError(`${what} is not a string`)
  return value
}

function operationOf(value: Json | undefined, what: string): ReplicationOperation {
  if (value !== 'INDEX' && value !== 'DELETE') throw new FormError(`${what} is not INDEX or DELETE`)
  return value
}

function recordFrame(record: JsonObject, what: string): Uint8Array {
  const document = record.document === undefined ? null : encodeDocument(plainOf(untagged(record.document), what))
  return frameRecord(
    buildEntry({
      seqNo: numberFromJson(record.seqNo ?? null, `${what}.seqNo`),
      primaryTerm: numberFromJson(record.primaryTerm ?? null, `${what}.primaryTerm`),
      operation: operationOf(record.operation, `${what}.operation`),
      partitionId: numberFromJson(record.partitionId ?? null, `${what}.partitionId`),
      indexName: stringAt(record.indexName, `${what}.indexName`),
      documentId: stringAt(record.documentId, `${what}.documentId`),
      document,
    }),
  )
}

export function writeLogSegment(json: JsonObject, what: string): Uint8Array {
  const header = writeSegmentHeader()
  header[WAL_FORMAT_VERSION_OFFSET] = numberFromJson(json.walFormatVersion ?? null, `${what}.walFormatVersion`)
  const frames = listAt(json.records, `${what}.records`).map((record, at) =>
    recordFrame(objectAt(record, `${what}.records[${at}]`), `${what}.records[${at}]`),
  )
  const bytes = joined([header, ...frames])
  readDurableRegion(bytes, bytes.byteLength)
  return bytes
}

export function writeCommitMarker(json: JsonObject, what: string): Uint8Array {
  const slots = listAt(json.slots, `${what}.slots`).map((slot, at) => {
    if (slot === null) return new Uint8Array(COMMIT_MARKER_SLOT_SIZE)
    const state = objectAt(slot, `${what}.slots[${at}]`)
    return encodeMarkerSlot({
      writeSeq: numberFromJson(state.writeSeq ?? null, `${what}.slots[${at}].writeSeq`),
      activeSegmentSeqNo: numberFromJson(state.activeSegmentSeqNo ?? null, `${what}.slots[${at}].activeSegmentSeqNo`),
      durableByteLength: numberFromJson(state.durableByteLength ?? null, `${what}.slots[${at}].durableByteLength`),
      highestDurableSeqNo: numberFromJson(
        state.highestDurableSeqNo ?? null,
        `${what}.slots[${at}].highestDurableSeqNo`,
      ),
    })
  })
  return joined(slots)
}

export function writeDocumentExport(json: JsonObject, what: string): Uint8Array {
  const lines = [`${encodeExactJson(objectAt(json.header, `${what}.header`), '')}\n`]
  for (const [at, entry] of listAt(json.documents, `${what}.documents`).entries()) {
    const line = objectAt(entry, `${what}.documents[${at}]`)
    const document = untagDocumentLine(JSON.stringify(line), structuredClone(line))
    lines.push(`${encodeDocumentJson(document, String(line.id))}\n`)
  }
  return UTF8.encode(lines.join(''))
}
