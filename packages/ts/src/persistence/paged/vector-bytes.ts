import { encode } from '@msgpack/msgpack'
import { compareCodePoints } from '../../core/ordering'
import { crc32 } from '../../serialization/crc32'
import type { NumberedHnswGraph } from '../../vector/hnsw'
import { magnitude } from '../../vector/similarity'
import type { VectorFilePayload, VectorGraphPartPayload } from '../../vector/vector-index/checkpoint-payload'
import { bytesToVectors } from '../../vector/vector-index/payload'
import { STABLE_HEAD_ATTEMPTS } from './constants'
import { type FileSection, RECORD_PAGE_BYTES, SEGMENT_PAGE_BYTES } from './format'

const BIN8 = 0xc4
const BIN16 = 0xc5
const BIN32 = 0xc6
const ARRAY16 = 0xdc
const ARRAY32 = 0xdd
const FIXMAP = 0x80
const FIXARRAY = 0x90
const FIXED_LIST_MAX = 15
const FIXSTR = 0xa0
const FIXSTR_MAX_LENGTH = 31
const ASCII_MAX = 0x7f
const UTF8_MAX_BYTES_PER_UNIT = 3
const STRING_HEADER_MAX_BYTES = 5
const BIN8_MAX_BYTES = 0xff
const UINT16_MAX = 0xffff

export interface PagedPartChunks {
  chunks: Uint8Array[]
  headOffset: number
  headLength: number
  headChecksum: number
}

function binHeader(byteLength: number): Uint8Array {
  if (byteLength <= BIN8_MAX_BYTES) return Uint8Array.of(BIN8, byteLength)
  if (byteLength <= UINT16_MAX) return Uint8Array.of(BIN16, byteLength >> 8, byteLength & 0xff)
  const header = new Uint8Array(5)
  header[0] = BIN32
  new DataView(header.buffer).setUint32(1, byteLength, false)
  return header
}

function arrayHeader(count: number): Uint8Array {
  if (count <= FIXED_LIST_MAX) return Uint8Array.of(FIXARRAY | count)
  if (count <= UINT16_MAX) return Uint8Array.of(ARRAY16, count >> 8, count & 0xff)
  const header = new Uint8Array(5)
  header[0] = ARRAY32
  new DataView(header.buffer).setUint32(1, count, false)
  return header
}

function createPayloadBuilder() {
  const chunks: Uint8Array[] = []
  let offset = 0
  function push(chunk: Uint8Array): void {
    chunks.push(chunk)
    offset += chunk.byteLength
  }
  return {
    chunks,
    get offset() {
      return offset
    },
    push,
    entry(key: string, value: unknown): void {
      push(encode(key))
      push(encode(value))
    },
    rawEntry(key: string, encoded: Uint8Array): number {
      push(encode(key))
      const at = offset
      push(encoded)
      return at
    },
    bytesEntry(key: string, bytes: Uint8Array): number {
      push(encode(key))
      push(binHeader(bytes.byteLength))
      const at = offset
      push(bytes)
      return at
    },
  }
}

function pageChecksums(bytes: Uint8Array, pageBytes: number): Uint8Array {
  const pages = Math.ceil(bytes.byteLength / pageBytes)
  const checksums = new Uint8Array(pages * 4)
  const view = new DataView(checksums.buffer)
  for (let page = 0; page < pages; page++) {
    const from = page * pageBytes
    view.setUint32(page * 4, crc32(bytes.subarray(from, Math.min(from + pageBytes, bytes.byteLength))), true)
  }
  return checksums
}

function sectionOf(name: string, offset: number, bytes: Uint8Array, pageBytes: number): FileSection {
  return { name, offset, length: bytes.byteLength, pageBytes, checksums: pageChecksums(bytes, pageBytes) }
}

function uint32Bytes(values: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i], true)
  return bytes
}

function writtenAsShortAscii(docId: string, list: Uint8Array, at: number): boolean {
  if (docId.length > FIXSTR_MAX_LENGTH) return false
  for (let unit = 0; unit < docId.length; unit++) {
    const code = docId.charCodeAt(unit)
    if (code > ASCII_MAX) return false
    list[at + 1 + unit] = code
  }
  list[at] = FIXSTR | docId.length
  return true
}

function encodedIdList(docIds: readonly string[]): { list: Uint8Array; offsets: Uint32Array } {
  const header = arrayHeader(docIds.length)
  let capacity = header.byteLength
  for (const docId of docIds) capacity += docId.length * UTF8_MAX_BYTES_PER_UNIT + STRING_HEADER_MAX_BYTES
  const list = new Uint8Array(capacity)
  list.set(header)
  const offsets = new Uint32Array(docIds.length + 1)
  let cursor = header.byteLength
  for (let i = 0; i < docIds.length; i++) {
    offsets[i] = cursor
    if (writtenAsShortAscii(docIds[i], list, cursor)) {
      cursor += docIds[i].length + 1
      continue
    }
    const encoded = encode(docIds[i])
    list.set(encoded, cursor)
    cursor += encoded.byteLength
  }
  offsets[docIds.length] = cursor
  return { list: list.subarray(0, cursor), offsets }
}

function positionsInIdOrder(docIds: readonly string[]): Uint32Array {
  const positions = Array.from(docIds.keys())
  positions.sort((left, right) => compareCodePoints(docIds[left], docIds[right]))
  return Uint32Array.from(positions)
}

function magnitudesOf(payload: VectorFilePayload): Uint8Array {
  const vectors = bytesToVectors(payload.vectors)
  const count = payload.docIds.length
  const bytes = new Uint8Array(count * 8)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < count; i++) {
    view.setFloat64(i * 8, magnitude(vectors.subarray(i * payload.dimension, (i + 1) * payload.dimension)), true)
  }
  return bytes
}

function encodedHeadAndVectorsPlace(
  sections: readonly FileSection[],
  headOffsetAfterHeader: (headLength: number) => number,
  vectors: Uint8Array,
  vectorsKeyAndHeaderBytes: number,
): { head: Uint8Array; vectorsSection: FileSection } {
  const checksums = pageChecksums(vectors, SEGMENT_PAGE_BYTES)
  let headLength = 0
  let head: Uint8Array = new Uint8Array(0)
  let vectorsSection: FileSection = {
    name: 'vectors',
    offset: 0,
    length: vectors.byteLength,
    pageBytes: SEGMENT_PAGE_BYTES,
    checksums,
  }
  for (let attempt = 0; attempt < STABLE_HEAD_ATTEMPTS; attempt++) {
    vectorsSection = {
      ...vectorsSection,
      offset: headOffsetAfterHeader(headLength) + headLength + vectorsKeyAndHeaderBytes,
    }
    head = encode({ sections: [...sections, vectorsSection] })
    if (head.byteLength === headLength) break
    headLength = head.byteLength
  }
  return { head, vectorsSection }
}

export function pagedVectorFileChunks(payload: VectorFilePayload): PagedPartChunks {
  const builder = createPayloadBuilder()
  const { codes } = payload
  builder.push(Uint8Array.of(FIXMAP | 10))
  builder.entry('v', payload.v)
  builder.entry('fieldName', payload.fieldName)
  builder.entry('dimension', payload.dimension)
  const { list, offsets } = encodedIdList(payload.docIds)
  const docIdsAt = builder.rawEntry('docIds', list)
  const sections: FileSection[] = [sectionOf('docIds', docIdsAt, list, SEGMENT_PAGE_BYTES)]
  builder.push(encode('codes'))
  if (codes === null) {
    builder.push(encode(null))
  } else {
    builder.push(Uint8Array.of(FIXMAP | 3))
    builder.entry('bits', codes.bits)
    builder.entry('centroid', codes.centroid)
    const recordsAt = builder.bytesEntry('records', codes.records)
    sections.push(sectionOf('records', recordsAt, codes.records, RECORD_PAGE_BYTES))
  }
  const magnitudes = magnitudesOf(payload)
  sections.push(sectionOf('magnitudes', builder.bytesEntry('magnitudes', magnitudes), magnitudes, SEGMENT_PAGE_BYTES))
  const idOffsets = uint32Bytes(offsets)
  sections.push(sectionOf('idOffsets', builder.bytesEntry('idOffsets', idOffsets), idOffsets, SEGMENT_PAGE_BYTES))
  const idOrder = uint32Bytes(positionsInIdOrder(payload.docIds))
  sections.push(sectionOf('idOrder', builder.bytesEntry('idOrder', idOrder), idOrder, SEGMENT_PAGE_BYTES))

  const headKey = encode('head')
  const vectorsKey = encode('vectors')
  const vectorsHeader = binHeader(payload.vectors.byteLength)
  const beforeHead = builder.offset + headKey.byteLength
  const { head } = encodedHeadAndVectorsPlace(
    sections,
    headLength => beforeHead + binHeader(headLength).byteLength,
    payload.vectors,
    vectorsKey.byteLength + vectorsHeader.byteLength,
  )
  const headOffset = builder.bytesEntry('head', head)
  builder.push(vectorsKey)
  builder.push(vectorsHeader)
  builder.push(payload.vectors)
  return { chunks: builder.chunks, headOffset, headLength: head.byteLength, headChecksum: crc32(head) }
}

function nodeOffsetsOf(graph: NumberedHnswGraph): Uint8Array {
  const offsets = new Uint32Array(graph.levels.length + 1)
  const view = new DataView(graph.neighbours.buffer, graph.neighbours.byteOffset, graph.neighbours.byteLength)
  let cursor = 0
  for (let at = 0; at < graph.levels.length; at++) {
    offsets[at] = cursor
    for (let layer = 0; layer < graph.levels[at]; layer++) cursor += (view.getUint32(cursor, true) + 1) * 4
  }
  offsets[graph.levels.length] = cursor
  return uint32Bytes(offsets)
}

export function pagedGraphPartChunks(part: VectorGraphPartPayload): PagedPartChunks {
  const builder = createPayloadBuilder()
  builder.push(Uint8Array.of(FIXMAP | 4))
  builder.entry('v', part.v)
  builder.entry('fieldName', part.fieldName)
  builder.push(encode('graphs'))
  builder.push(arrayHeader(part.graphs.length))
  const layouts: unknown[] = []
  for (const graph of part.graphs) {
    const { levels, neighbours, ...header } = graph
    const headerEntries = Object.entries(header).filter(([, value]) => value !== undefined)
    builder.push(Uint8Array.of(FIXMAP | (headerEntries.length + 2)))
    for (const [key, value] of headerEntries) builder.entry(key, value)
    const levelsAt = builder.bytesEntry('levels', levels)
    const neighboursAt = builder.bytesEntry('neighbours', neighbours)
    layouts.push({
      ...header,
      levels: sectionOf('levels', levelsAt, levels, SEGMENT_PAGE_BYTES),
      nodeOffsets: nodeOffsetsOf(graph),
      neighbours: sectionOf('neighbours', neighboursAt, neighbours, RECORD_PAGE_BYTES),
    })
  }
  const head = encode({ graphs: layouts })
  const headOffset = builder.bytesEntry('head', head)
  return { chunks: builder.chunks, headOffset, headLength: head.byteLength, headChecksum: crc32(head) }
}
