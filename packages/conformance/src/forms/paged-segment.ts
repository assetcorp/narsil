import { inflateRawSync } from 'node:zlib'
import type { FieldCodec, FormContext } from './codec'
import { type Decoded, FormError, fieldOf, listOf, mapOf, numberOf, stringOf } from './decoded'
import { type HeaderForm, headerJson } from './header'
import { type Json, type JsonObject, tagged } from './json'
import { COLUMN_CODECS, surfaceFormColumn } from './keyword-segment'
import { type NumberWidth, numbersJson, numbersOf, textsOf } from './numbers'

const PREFIX_BYTES = 8
const MAX_DOCUMENT_BLOCK_RAW_BYTES = 16_842_752
const BLOCK_SUMMARY_BYTES = 22
const DOCUMENT_BLOCK_BYTES = 20
const POSTING_BYTES = 8
const HEAD_KEYS = ['v', 'schema', 'tombstones', 'documentCount', 'fieldNames'] as const

const NUMBER_SECTIONS: Record<string, NumberWidth> = {
  documentFrequencies: 'uint32',
  postingOffsets: 'uint32',
  blockLists: 'uint32',
  blockListOffsets: 'uint32',
  tokenTotals: 'float64',
  positionOffsets: 'uint32',
  positions: 'uint32',
  idOrder: 'uint32',
  removalOffsets: 'uint32',
  removals: 'uint32',
  seqNos: 'uint64',
  primaryTerms: 'uint64',
}

const PACKED_COLUMN_SECTIONS = ['fieldLengths', 'numeric', 'sizes', 'boolean', 'enum', 'geopoint', 'pattern']
const PLACEMENT_SECTIONS = new Set(['documentBlocks', 'tokenOffsets', 'idOffsets', 'postings', 'documents', 'ids'])

export interface PagedSegmentParts {
  head: Map<string, Decoded>
  sections: Map<string, Uint8Array>
}

export function pagedSegmentParts(payload: Uint8Array, context: FormContext, what: string): PagedSegmentParts {
  if (payload.byteLength < PREFIX_BYTES) throw new FormError(`${what} ends inside its payload prefix`)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const headLength = view.getUint32(0, true)
  if (PREFIX_BYTES + headLength > payload.byteLength) throw new FormError(`${what} ends its head outside the payload`)
  const head = mapOf(context.unpack(payload.subarray(PREFIX_BYTES, PREFIX_BYTES + headLength), `${what} head`), what)
  const sections = new Map<string, Uint8Array>()
  for (const [at, entry] of listOf(fieldOf(head, 'sections', what), `${what} sections`).entries()) {
    const section = mapOf(entry, `${what} section ${at}`)
    const name = stringOf(fieldOf(section, 'name', what), `${what} section ${at} name`)
    const offset = numberOf(fieldOf(section, 'offset', what), `${what} section ${name} offset`)
    const length = numberOf(fieldOf(section, 'length', what), `${what} section ${name} length`)
    if (offset + length > payload.byteLength) throw new FormError(`${what} ends section ${name} outside the payload`)
    if (sections.has(name)) throw new FormError(`${what} repeats section ${name}`)
    sections.set(name, payload.subarray(offset, offset + length))
  }
  return { head, sections }
}

function requireSection(parts: PagedSegmentParts, name: string, what: string): Uint8Array {
  const bytes = parts.sections.get(name)
  if (bytes === undefined) throw new FormError(`${what} holds no ${name} section`)
  return bytes
}

function postingLists(parts: PagedSegmentParts, what: string): JsonObject {
  const offsets = numbersOf(requireSection(parts, 'postingOffsets', what), 'uint32', `${what} postingOffsets`)
  const postings = requireSection(parts, 'postings', what)
  const view = new DataView(postings.buffer, postings.byteOffset, postings.byteLength)
  const documents: number[] = []
  const frequencies: number[] = []
  const fields: number[] = []
  for (let token = 0; token + 1 < offsets.length; token++) {
    const first = offsets[token]
    const count = offsets[token + 1] - first
    const start = first * POSTING_BYTES
    if (count < 0 || start + count * POSTING_BYTES > postings.byteLength) {
      throw new FormError(`${what} gives token ${token} postings outside the postings section`)
    }
    for (let at = 0; at < count; at++) documents.push(view.getUint32(start + at * 4, true))
    for (let at = 0; at < count; at++) frequencies.push(view.getUint16(start + count * 4 + at * 2, true))
    for (let at = 0; at < count; at++) fields.push(view.getUint16(start + count * 6 + at * 2, true))
  }
  return { postingDocuments: documents, postingFrequencies: frequencies, postingFields: fields }
}

function documentList(parts: PagedSegmentParts, documentCount: number, context: FormContext, what: string): Json[] {
  const blocks = requireSection(parts, 'documentBlocks', what)
  const documents = requireSection(parts, 'documents', what)
  if (blocks.byteLength % DOCUMENT_BLOCK_BYTES !== 0) throw new FormError(`${what} holds a partial document block`)
  const view = new DataView(blocks.buffer, blocks.byteOffset, blocks.byteLength)
  const blockCount = blocks.byteLength / DOCUMENT_BLOCK_BYTES
  const list: Json[] = []
  for (let block = 0; block < blockCount; block++) {
    const at = block * DOCUMENT_BLOCK_BYTES
    const firstOrdinal = view.getUint32(at, true)
    const offset = Number(view.getBigUint64(at + 4, true))
    const length = view.getUint32(at + 12, true)
    const rawLength = view.getUint32(at + 16, true)
    const end = block + 1 < blockCount ? view.getUint32(at + DOCUMENT_BLOCK_BYTES, true) : documentCount
    if (firstOrdinal !== list.length) throw new FormError(`${what} starts document block ${block} at ${firstOrdinal}`)
    if (rawLength > MAX_DOCUMENT_BLOCK_RAW_BYTES || offset + length > documents.byteLength) {
      throw new FormError(`${what} gives document block ${block} a length outside its limits`)
    }
    const raw = new Uint8Array(
      inflateRawSync(documents.subarray(offset, offset + length), { maxOutputLength: MAX_DOCUMENT_BLOCK_RAW_BYTES }),
    )
    if (raw.byteLength !== rawLength) throw new FormError(`${what} block ${block} inflates to ${raw.byteLength} bytes`)
    const documentsOfBlock = context.unpackSequence(raw, `${what} block ${block}`)
    if (end < firstOrdinal || documentsOfBlock.length !== end - firstOrdinal) {
      throw new FormError(`${what} block ${block} holds ${documentsOfBlock.length} documents`)
    }
    for (const document of documentsOfBlock) list.push(tagged(document))
  }
  if (list.length !== documentCount) throw new FormError(`${what} blocks hold ${list.length} documents`)
  return list
}

function blockSummaryList(bytes: Uint8Array, what: string): Json[] {
  if (bytes.byteLength % BLOCK_SUMMARY_BYTES !== 0) throw new FormError(`${what} holds a partial block summary`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const summaries: Json[] = []
  for (let at = 0; at < bytes.byteLength; at += BLOCK_SUMMARY_BYTES) {
    summaries.push({
      postingEnd: view.getUint32(at, true),
      maxTermFrequency: view.getUint16(at + 4, true),
      minFieldLength: view.getFloat64(at + 6, true),
      maxEntriesPerDocument: view.getUint32(at + 14, true),
      documentCount: view.getUint32(at + 18, true),
    })
  }
  return summaries
}

function columnCodecOf(name: string): FieldCodec {
  const codec = COLUMN_CODECS[name]
  if (codec === undefined) throw new FormError(`no column codec is named ${name}`)
  return codec
}

function sectionJson(parts: PagedSegmentParts, name: string, context: FormContext, what: string): Json {
  const bytes = requireSection(parts, name, what)
  const path = `${what} section ${name}`
  if (name === 'blockSummaries') return blockSummaryList(bytes, path)
  if (name === 'idSample') return tagged(context.unpack(bytes, path))
  if (name === 'surfaceForms') return surfaceFormColumn.toJson(context.unpack(bytes, path), path, context)
  if (name === 'partialWords') return columnCodecOf(name).toJson(context.unpack(bytes, path), path, context)
  if (PACKED_COLUMN_SECTIONS.includes(name))
    return columnCodecOf(name).toJson(context.unpack(bytes, path), path, context)
  const width = NUMBER_SECTIONS[name]
  return width === undefined ? { $bytes: Buffer.from(bytes).toString('base64') } : numbersJson(bytes, width, path)
}

export function pagedSegmentJson(
  header: HeaderForm,
  payload: Uint8Array,
  context: FormContext,
  what: string,
): JsonObject {
  const parts = pagedSegmentParts(payload, context, what)
  const head: JsonObject = {}
  for (const key of HEAD_KEYS) head[key] = tagged(fieldOf(parts.head, key, `${what} head`))
  const documentCount = numberOf(fieldOf(parts.head, 'documentCount', what), `${what} documentCount`)
  const sections: JsonObject = {}
  for (const name of parts.sections.keys()) {
    if (PLACEMENT_SECTIONS.has(name)) continue
    sections[name] = sectionJson(parts, name, context, what)
  }
  sections.tokens = textsOf(
    requireSection(parts, 'tokens', what),
    numbersOf(requireSection(parts, 'tokenOffsets', what), 'uint32', `${what} tokenOffsets`),
    `${what} tokens`,
  )
  sections.ids = textsOf(
    requireSection(parts, 'ids', what),
    numbersOf(requireSection(parts, 'idOffsets', what), 'uint32', `${what} idOffsets`),
    `${what} ids`,
  )
  Object.assign(sections, postingLists(parts, what))
  sections.documents = documentList(parts, documentCount, context, what)
  return { header: headerJson(header), head, sections }
}
