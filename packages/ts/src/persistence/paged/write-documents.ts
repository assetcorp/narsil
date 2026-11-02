import { encode } from '@msgpack/msgpack'
import { deflateBlock } from '#platform/raw-deflate'
import { compareCodePoints } from '../../core/ordering'
import type { FrozenSegment } from '../../core/partition/frozen'
import { holdsADiscardedField } from '../../core/partition/frozen/merge'
import type { SegmentRemap } from '../../core/partition/frozen/merge-postings'
import { encodeDocument } from '../../serialization/document-encoding'
import { littleEndianBytes } from '../../serialization/keyword-segment/little-endian'
import type { SegmentWriteRecords } from '../../serialization/keyword-segment/types'
import { uint64Bytes } from '../../serialization/keyword-segment/write-records'
import { DOCUMENT_BLOCK_BYTES, DOCUMENT_BLOCK_MIN_RAW_BYTES, ID_SAMPLE_INTERVAL } from './format'
import type { SectionSink } from './sink'

const encoder = new TextEncoder()

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function encodedDocumentOf(segment: FrozenSegment, ordinal: number): Uint8Array {
  if (segment.paged !== null) return segment.paged.encodedDocumentAt(ordinal)
  const table = segment.arrays.documentTable
  if (table === null) return encodeDocument(segment.documentSource.docAt(ordinal))
  const stored = table.blob.subarray(table.offsets[ordinal], table.offsets[ordinal + 1])
  const { discardedFields } = table
  if (discardedFields === undefined || !holdsADiscardedField(stored, discardedFields)) return stored
  return encodeDocument(segment.documentSource.docAt(ordinal))
}

export interface DocumentSinks {
  documents: SectionSink
  ids: SectionSink
  idOffsets: SectionSink
  seqNos: SectionSink | null
  primaryTerms: SectionSink | null
}

export async function writeDocumentRows(
  inputs: readonly SegmentRemap[],
  sinks: DocumentSinks,
  writeRecords: ReadonlyMap<FrozenSegment, SegmentWriteRecords> | undefined,
): Promise<Uint8Array> {
  const blocks: Uint8Array[] = []
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  let firstOrdinal = 0
  let compressedAt = 0
  let idBytes = 0
  const single = new Uint32Array(1)
  const seqNo = new Float64Array(1)
  const primaryTerm = new Float64Array(1)

  async function closeBlock(): Promise<void> {
    if (pendingBytes === 0) return
    const raw = new Uint8Array(pendingBytes)
    let at = 0
    for (const chunk of pending) {
      raw.set(chunk, at)
      at += chunk.byteLength
    }
    const compressed = deflateBlock(raw)
    const entry = new Uint8Array(DOCUMENT_BLOCK_BYTES)
    const view = new DataView(entry.buffer)
    view.setUint32(0, firstOrdinal, true)
    view.setBigUint64(4, BigInt(compressedAt), true)
    view.setUint32(12, compressed.byteLength, true)
    view.setUint32(16, raw.byteLength, true)
    blocks.push(entry)
    await sinks.documents.write(compressed)
    compressedAt += compressed.byteLength
    pending = []
    pendingBytes = 0
    await yieldToEventLoop()
  }

  single[0] = 0
  await sinks.idOffsets.write(littleEndianBytes(single))
  for (const input of inputs) {
    const { segment, remap } = input
    const records = writeRecords?.get(segment)
    for (let ordinal = 0; ordinal < remap.length; ordinal++) {
      const target = remap[ordinal]
      if (target < 0) continue
      if (pendingBytes === 0) firstOrdinal = target
      const encoded = encodedDocumentOf(segment, ordinal)
      pending.push(encoded.slice())
      pendingBytes += encoded.byteLength
      if (pendingBytes >= DOCUMENT_BLOCK_MIN_RAW_BYTES) await closeBlock()
      const id = encoder.encode(segment.arrays.idTable.idAt(ordinal))
      await sinks.ids.write(id)
      idBytes += id.byteLength
      single[0] = idBytes
      await sinks.idOffsets.write(littleEndianBytes(single))
      if (sinks.seqNos !== null && sinks.primaryTerms !== null) {
        if (segment.paged !== null) {
          const held = segment.paged.writeRecordAt(ordinal)
          seqNo[0] = held.seqNo
          primaryTerm[0] = held.primaryTerm
        } else {
          seqNo[0] = records?.seqNos[ordinal] ?? 0
          primaryTerm[0] = records?.primaryTerms[ordinal] ?? 0
        }
        await sinks.seqNos.write(uint64Bytes(seqNo))
        await sinks.primaryTerms.write(uint64Bytes(primaryTerm))
      }
    }
  }
  await closeBlock()
  const blockBytes = new Uint8Array(blocks.length * DOCUMENT_BLOCK_BYTES)
  for (let at = 0; at < blocks.length; at++) blockBytes.set(blocks[at], at * DOCUMENT_BLOCK_BYTES)
  return blockBytes
}

interface IdCursor {
  input: SegmentRemap
  position: number
  ordinal: number
  id: string
}

function advance(cursor: IdCursor): boolean {
  const table = cursor.input.segment.arrays.idTable
  for (;;) {
    cursor.position += 1
    if (cursor.position >= table.count) return false
    const ordinal = table.sortedOrdinalAt(cursor.position)
    if (cursor.input.remap[ordinal] < 0) continue
    cursor.ordinal = ordinal
    cursor.id = table.idAt(ordinal)
    return true
  }
}

export async function writeIdOrder(inputs: readonly SegmentRemap[], idOrder: SectionSink): Promise<Uint8Array> {
  const cursors: IdCursor[] = []
  for (const input of inputs) {
    const cursor: IdCursor = { input, position: -1, ordinal: 0, id: '' }
    if (advance(cursor)) cursors.push(cursor)
  }
  const sample: Array<[string, number]> = []
  const single = new Uint32Array(1)
  let position = 0
  while (cursors.length > 0) {
    let least = 0
    for (let at = 1; at < cursors.length; at++) {
      if (compareCodePoints(cursors[at].id, cursors[least].id) < 0) least = at
    }
    const cursor = cursors[least]
    single[0] = cursor.input.remap[cursor.ordinal]
    await idOrder.write(littleEndianBytes(single))
    if (position % ID_SAMPLE_INTERVAL === 0) sample.push([cursor.id, position])
    position += 1
    if (!advance(cursor)) cursors.splice(least, 1)
    if (position % DOCUMENT_BLOCK_MIN_RAW_BYTES === 0) await yieldToEventLoop()
  }
  return encode(sample)
}
