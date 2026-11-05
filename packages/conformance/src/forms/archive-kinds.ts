import type { FormContext } from './codec'
import { FormError } from './decoded'
import { keywordSegmentJson, manifestJson, mirroredMapJson } from './envelope-kinds'
import { isJsonObject, type Json, type JsonObject } from './json'
import { pagedSegmentJson } from './paged-segment'
import { graphPartJson, type VectorStorage, vectorFileJson } from './vector-kinds'

const TAR_BLOCK_BYTES = 512
const NAME_BYTES = 100
const SIZE_OFFSET = 124
const SIZE_BYTES = 12
const CHECKSUM_OFFSET = 148
const CHECKSUM_BYTES = 8
const TYPEFLAG_OFFSET = 156
const PREFIX_OFFSET = 345
const PREFIX_BYTES = 155
const REGULAR_FILE = 0x30
const OLD_REGULAR_FILE = 0
const PAX_HEADER = 0x78
const SPACE = 0x20
const KEYWORD_SEGMENT_ENVELOPE_VERSION = 4
const PAGED_SEGMENT_ENVELOPE_VERSION = 6
const ENVELOPE_VERSION_OFFSET = 4
const SEGMENT_ENTRY = /^segments\/\d+\/s\d{16}$/
const GRAPH_PART_ENTRY = /^segments\/vec-.+-graph-g\d+-p\d{16}$/
const VECTOR_FILE_ENTRY = /^segments\/vec-.+-f\d{16}$/
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

export interface ArchiveEntry {
  name: string
  bytes: Uint8Array
}

function textField(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return strictUtf8.decode(end < 0 ? field : field.subarray(0, end))
}

function octalField(block: Uint8Array, offset: number, length: number, what: string): number {
  const text = textField(block, offset, length).trim()
  if (!/^[0-7]+$/.test(text)) throw new FormError(`${what} is not an octal number`)
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value)) throw new FormError(`${what} is too large`)
  return value
}

function headerChecksumOf(block: Uint8Array): number {
  let sum = 0
  for (let at = 0; at < TAR_BLOCK_BYTES; at++) {
    sum += at >= CHECKSUM_OFFSET && at < CHECKSUM_OFFSET + CHECKSUM_BYTES ? SPACE : block[at]
  }
  return sum
}

function paxPath(body: Uint8Array, what: string): string | null {
  let at = 0
  let path: string | null = null
  while (at < body.byteLength) {
    const space = body.indexOf(SPACE, at)
    const length = space < 0 ? Number.NaN : Number.parseInt(strictUtf8.decode(body.subarray(at, space)), 10)
    if (!Number.isSafeInteger(length) || length <= space - at || at + length > body.byteLength) {
      throw new FormError(`${what} holds a malformed pax record`)
    }
    const record = strictUtf8.decode(body.subarray(space + 1, at + length))
    const equals = record.indexOf('=')
    if (equals < 0 || !record.endsWith('\n')) throw new FormError(`${what} holds a pax record without a value`)
    if (record.slice(0, equals) === 'path') path = record.slice(equals + 1, -1)
    at += length
  }
  return path
}

export function archiveEntries(bytes: Uint8Array, what: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  let offset = 0
  let pendingPath: string | null = null
  while (offset + TAR_BLOCK_BYTES <= bytes.byteLength) {
    const block = bytes.subarray(offset, offset + TAR_BLOCK_BYTES)
    if (block.every(byte => byte === 0)) return entries
    const path = `${what} entry at byte ${offset}`
    if (octalField(block, CHECKSUM_OFFSET, CHECKSUM_BYTES, `${path} checksum`) !== headerChecksumOf(block)) {
      throw new FormError(`${path} fails its header checksum`)
    }
    const size = octalField(block, SIZE_OFFSET, SIZE_BYTES, `${path} size`)
    const start = offset + TAR_BLOCK_BYTES
    if (start + size > bytes.byteLength) throw new FormError(`${path} ends outside the archive`)
    const body = bytes.subarray(start, start + size)
    offset = start + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
    const type = block[TYPEFLAG_OFFSET]
    if (type === PAX_HEADER) {
      pendingPath = paxPath(body, path)
      continue
    }
    if (type !== REGULAR_FILE && type !== OLD_REGULAR_FILE) throw new FormError(`${path} is not a regular file`)
    const name = textField(block, 0, NAME_BYTES)
    const prefix = textField(block, PREFIX_OFFSET, PREFIX_BYTES)
    entries.push({ name: pendingPath ?? (prefix.length > 0 ? `${prefix}/${name}` : name), bytes: body })
    pendingPath = null
  }
  throw new FormError(`${what} ends before its end-of-archive blocks`)
}

function vectorStorageOf(config: JsonObject): VectorStorage {
  const payload = config.payload
  const promotion = isJsonObject(payload) ? payload.vectorPromotion : undefined
  return isJsonObject(promotion) && promotion.storage === 'disk' ? 'disk' : 'memory'
}

async function segmentEntryJson(entry: ArchiveEntry, context: FormContext, what: string): Promise<JsonObject> {
  const version = entry.bytes[ENVELOPE_VERSION_OFFSET]
  if (version === KEYWORD_SEGMENT_ENVELOPE_VERSION) return keywordSegmentJson(entry.bytes, context, what)
  if (version !== PAGED_SEGMENT_ENVELOPE_VERSION) throw new FormError(`${what} holds envelope version ${version}`)
  const { header, payload } = await context.openEnvelope(entry.bytes, what)
  return pagedSegmentJson(header, payload, context, what)
}

export async function archiveJson(bytes: Uint8Array, context: FormContext, what: string): Promise<JsonObject> {
  const entries = archiveEntries(bytes, what)
  const [config, manifest, ...files] = entries
  if (config?.name !== 'config' || manifest?.name !== 'manifest') {
    throw new FormError(`${what} does not begin with its config and manifest entries`)
  }
  const configJson = await mirroredMapJson(config.bytes, context, `${what} config`)
  const storage = vectorStorageOf(configJson)
  const list: Json[] = [
    { name: 'config', content: configJson },
    { name: 'manifest', content: await manifestJson(manifest.bytes, context, `${what} manifest`, true) },
  ]
  for (const entry of files) {
    const path = `${what} ${entry.name}`
    let content: JsonObject
    if (SEGMENT_ENTRY.test(entry.name)) content = await segmentEntryJson(entry, context, path)
    else if (GRAPH_PART_ENTRY.test(entry.name)) content = await graphPartJson(entry.bytes, storage, context, path)
    else if (VECTOR_FILE_ENTRY.test(entry.name)) content = await vectorFileJson(entry.bytes, storage, context, path)
    else throw new FormError(`${what} holds an entry named ${entry.name}`)
    list.push({ name: entry.name, content })
  }
  return { entries: list }
}

export function documentExportJson(bytes: Uint8Array, what: string): JsonObject {
  const text = strictUtf8.decode(bytes)
  if (!text.endsWith('\n')) throw new FormError(`${what} does not end with a line feed`)
  const [header, ...documents] = text.slice(0, -1).split('\n')
  const parse = (line: string, at: number): Json => {
    const value: Json = JSON.parse(line)
    if (!isJsonObject(value)) throw new FormError(`${what} line ${at + 1} is not an object`)
    return value
  }
  return { header: parse(header, 0), documents: documents.map((line, at) => parse(line, at + 1)) }
}
