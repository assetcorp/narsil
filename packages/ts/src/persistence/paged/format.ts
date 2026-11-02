import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import { crc32 } from '../../serialization/crc32'

export const PAGED_SEGMENT_ENVELOPE_VERSION = 6
export const PAGED_SEGMENT_HEAD_VERSION = 1
export const SEGMENT_PAGE_BYTES = 65_536
export const RECORD_PAGE_BYTES = 16_384
export const SECTION_ALIGNMENT_BYTES = 4
export const PAYLOAD_PREFIX_BYTES = 8
export const POSTING_WIDTH_BYTES = 8
export const POSITION_WIDTH_BYTES = 4
export const SMALLEST_BLOCK_POSTINGS = 128
export const DOCUMENT_BLOCK_MIN_RAW_BYTES = 65_536
export const MAX_DOCUMENT_BLOCK_RAW_BYTES = 16_842_752
export const ID_SAMPLE_INTERVAL = 256
export const BLOCK_SUMMARY_BYTES = 22
export const DOCUMENT_BLOCK_BYTES = 20

export type SectionName =
  | 'tokens'
  | 'tokenOffsets'
  | 'documentFrequencies'
  | 'postingOffsets'
  | 'blockLists'
  | 'blockListOffsets'
  | 'blockSummaries'
  | 'tokenTotals'
  | 'fieldLengths'
  | 'numeric'
  | 'sizes'
  | 'boolean'
  | 'enum'
  | 'geopoint'
  | 'pattern'
  | 'partialWords'
  | 'documentBlocks'
  | 'idSample'
  | 'postings'
  | 'positionOffsets'
  | 'positions'
  | 'documents'
  | 'ids'
  | 'idOffsets'
  | 'idOrder'
  | 'removalOffsets'
  | 'removals'
  | 'surfaceForms'
  | 'seqNos'
  | 'primaryTerms'

export interface FileSection {
  name: string
  offset: number
  length: number
  pageBytes: number
  checksums: Uint8Array
}

export interface PagedSegmentHead {
  v: number
  schema: Record<string, string>
  tombstones: string[]
  documentCount: number
  fieldNames: string[]
  sections: FileSection[]
}

export function loadFailed(message: string, details?: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, message, details)
}

export function pageCountOf(section: Pick<FileSection, 'length' | 'pageBytes'>): number {
  return Math.ceil(section.length / section.pageBytes)
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function decodeSection(raw: unknown, what: string, allowedPageBytes: ReadonlySet<number>): FileSection {
  if (raw === null || typeof raw !== 'object') loadFailed(`The ${what} lists a section that is not a map`)
  const entry = raw as Record<string, unknown>
  const { name, offset, length, pageBytes, checksums } = entry
  if (typeof name !== 'string' || name.length === 0) loadFailed(`The ${what} lists a section without a name`)
  if (!isByteCount(offset) || !isByteCount(length)) {
    loadFailed(`The ${what} gives section "${name}" an invalid place`, { section: name, offset, length })
  }
  if (typeof pageBytes !== 'number' || !allowedPageBytes.has(pageBytes)) {
    loadFailed(`The ${what} gives section "${name}" a page size of ${String(pageBytes)}`, { section: name, pageBytes })
  }
  if (!(checksums instanceof Uint8Array)) loadFailed(`The ${what} gives section "${name}" no checksums`)
  if (checksums.byteLength !== Math.ceil(length / pageBytes) * 4) {
    loadFailed(`The ${what} gives section "${name}" ${checksums.byteLength} bytes of checksums`, {
      section: name,
      checksumBytes: checksums.byteLength,
    })
  }
  return { name, offset, length, pageBytes, checksums }
}

export function decodeSections(
  raw: unknown,
  payloadLength: number,
  what: string,
  allowedPageBytes: ReadonlySet<number>,
): FileSection[] {
  if (!Array.isArray(raw)) loadFailed(`The ${what} holds no section list`)
  const sections = raw.map(entry => decodeSection(entry, what, allowedPageBytes))
  const names = new Set<string>()
  for (const section of sections) {
    if (names.has(section.name)) loadFailed(`The ${what} repeats section "${section.name}"`, { section: section.name })
    names.add(section.name)
    if (section.offset + section.length > payloadLength) {
      loadFailed(`The ${what} ends section "${section.name}" outside the payload`, { section: section.name })
    }
  }
  const byOffset = [...sections].sort((left, right) => left.offset - right.offset)
  for (let at = 1; at < byOffset.length; at++) {
    const before = byOffset[at - 1]
    if (before.offset + before.length > byOffset[at].offset) {
      loadFailed(`The ${what} overlaps section "${before.name}" with "${byOffset[at].name}"`, {
        section: before.name,
      })
    }
  }
  return sections
}

const SEGMENT_PAGE_SIZES: ReadonlySet<number> = new Set([SEGMENT_PAGE_BYTES])

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(entry => typeof entry === 'string')
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

export function decodePagedSegmentHead(head: Uint8Array, payloadLength: number, what: string): PagedSegmentHead {
  let raw: unknown
  try {
    raw = decode(head)
  } catch (error) {
    loadFailed(`The head of ${what} is not MessagePack: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (raw === null || typeof raw !== 'object') loadFailed(`The head of ${what} is not a map`)
  const entry = raw as Record<string, unknown>
  if (entry.v !== PAGED_SEGMENT_HEAD_VERSION) {
    loadFailed(`The head of ${what} holds version ${String(entry.v)}`, { version: entry.v })
  }
  if (!isStringRecord(entry.schema)) loadFailed(`The head of ${what} holds no schema`)
  if (!isStringList(entry.tombstones)) loadFailed(`The head of ${what} holds no tombstone list`)
  if (!isStringList(entry.fieldNames)) loadFailed(`The head of ${what} holds no field names`)
  const { documentCount } = entry
  if (typeof documentCount !== 'number' || !Number.isInteger(documentCount) || documentCount < 0) {
    loadFailed(`The head of ${what} holds an invalid document count`, { documentCount })
  }
  if (documentCount > 0xffff_ffff) loadFailed(`The head of ${what} holds a document count above uint32`)
  return {
    v: PAGED_SEGMENT_HEAD_VERSION,
    schema: entry.schema,
    tombstones: entry.tombstones,
    documentCount,
    fieldNames: entry.fieldNames,
    sections: decodeSections(entry.sections, payloadLength, `head of ${what}`, SEGMENT_PAGE_SIZES),
  }
}

function alignedUp(offset: number): number {
  const over = offset % SECTION_ALIGNMENT_BYTES
  return over === 0 ? offset : offset + SECTION_ALIGNMENT_BYTES - over
}

export interface PlannedSection {
  name: SectionName
  length: number
  checksums: Uint8Array
}

export interface EncodedSegmentHead {
  head: Uint8Array
  prefix: Uint8Array
  sections: FileSection[]
  payloadLength: number
}

function placeSections(planned: readonly PlannedSection[], sectionsStart: number): FileSection[] {
  let cursor = sectionsStart
  return planned.map(section => {
    const offset = alignedUp(cursor)
    cursor = offset + section.length
    return {
      name: section.name,
      offset,
      length: section.length,
      pageBytes: SEGMENT_PAGE_BYTES,
      checksums: section.checksums,
    }
  })
}

export function encodePagedSegmentHead(
  fields: Pick<PagedSegmentHead, 'schema' | 'tombstones' | 'documentCount' | 'fieldNames'>,
  planned: readonly PlannedSection[],
): EncodedSegmentHead {
  let headLength = 0
  for (;;) {
    const sectionsStart = alignedUp(PAYLOAD_PREFIX_BYTES + headLength)
    const sections = placeSections(planned, sectionsStart)
    const head = encode({ v: PAGED_SEGMENT_HEAD_VERSION, ...fields, sections })
    if (head.byteLength !== headLength) {
      headLength = head.byteLength
      continue
    }
    const prefix = new Uint8Array(PAYLOAD_PREFIX_BYTES)
    const view = new DataView(prefix.buffer)
    view.setUint32(0, head.byteLength, true)
    view.setUint32(4, crc32(head), true)
    const last = sections[sections.length - 1]
    const payloadLength = last === undefined ? sectionsStart : last.offset + last.length
    return { head, prefix, sections, payloadLength }
  }
}

export function sectionNamed(sections: readonly FileSection[], name: string): FileSection | undefined {
  for (const section of sections) {
    if (section.name === name) return section
  }
  return undefined
}
