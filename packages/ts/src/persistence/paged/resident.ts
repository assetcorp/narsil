import { decode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import type { PagedSegmentSnapshot } from '../../core/partition/frozen/paged-snapshot'
import { ErrorCodes, NarsilError } from '../../errors'
import { VECTOR_PATTERN } from '../../schema/validator/shared'
import { crc32 } from '../../serialization/crc32'
import { HEADER_SIZE, readHeader } from '../../serialization/header'
import {
  type ColumnContext,
  decodeBooleanColumns,
  decodeEnumColumns,
  decodeFieldLengths,
  decodeGeopointColumns,
  decodePartialWords,
  decodePatternColumns,
  decodeValueColumns,
} from '../../serialization/keyword-segment/decode-columns'
import { uint32sFrom } from '../../serialization/keyword-segment/little-endian'
import { requireEntriesAscend, requireOffsets, requireUtf8Entries } from '../../serialization/keyword-segment/validate'
import {
  BLOCK_SUMMARY_BYTES,
  DOCUMENT_BLOCK_BYTES,
  decodePagedSegmentHead,
  type FileSection,
  loadFailed,
  PAGED_SEGMENT_ENVELOPE_VERSION,
  PAYLOAD_PREFIX_BYTES,
  type PagedSegmentHead,
  SMALLEST_BLOCK_POSTINGS,
  sectionNamed,
} from './format'
import { readFileRange, readWholeSectionChecked } from './section-file'

export interface PagedFileListing {
  key: string
  path: string
  bytes: number
  checksum: number
}

function sharedMemoryAvailable(): boolean {
  return typeof SharedArrayBuffer === 'function'
}

function identitySlots(count: number, shared: boolean): Uint32Array {
  const slots = shared ? new Uint32Array(new SharedArrayBuffer(count * 4)) : new Uint32Array(count)
  for (let at = 0; at < count; at++) slots[at] = at
  return slots
}

export function readPagedHead(listing: PagedFileListing): { head: PagedSegmentHead; payloadLength: number } {
  const { path, key, bytes, checksum } = listing
  const header = new Uint8Array(HEADER_SIZE + PAYLOAD_PREFIX_BYTES)
  if (bytes < header.byteLength) loadFailed(`The segment "${key}" is too short to hold a head`, { key, bytes })
  readFileRange(path, 0, header)
  const opened = readHeader(header)
  if (opened.envelopeFormatVersion !== PAGED_SEGMENT_ENVELOPE_VERSION) {
    throw new NarsilError(
      ErrorCodes.ENVELOPE_VERSION_MISMATCH,
      `The segment "${key}" holds envelope format v${opened.envelopeFormatVersion}`,
      { key, version: opened.envelopeFormatVersion },
    )
  }
  if (opened.flags.compressionEnabled) loadFailed(`The segment "${key}" is compressed, while its format stores it raw`)
  if (HEADER_SIZE + opened.payloadLength !== bytes) {
    loadFailed(
      `The segment "${key}" holds ${bytes} bytes where its header gives ${HEADER_SIZE + opened.payloadLength}`,
      {
        key,
      },
    )
  }
  if (opened.checksum !== checksum) {
    loadFailed(`The segment "${key}" carries checksum ${opened.checksum} where the manifest lists ${checksum}`, { key })
  }
  const prefix = new DataView(header.buffer, HEADER_SIZE, PAYLOAD_PREFIX_BYTES)
  const headLength = prefix.getUint32(0, true)
  const headChecksum = prefix.getUint32(4, true)
  if (PAYLOAD_PREFIX_BYTES + headLength > opened.payloadLength) {
    loadFailed(`The head of the segment "${key}" ends outside its payload`, { key, headLength })
  }
  const head = new Uint8Array(headLength)
  readFileRange(path, HEADER_SIZE + PAYLOAD_PREFIX_BYTES, head)
  if (crc32(head) !== headChecksum) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_CRC_MISMATCH, `The head of the segment "${key}" fails its checksum`, {
      key,
    })
  }
  return {
    head: decodePagedSegmentHead(head, opened.payloadLength, `the segment "${key}"`),
    payloadLength: opened.payloadLength,
  }
}

function requireSection(sections: readonly FileSection[], name: string, key: string): FileSection {
  const section = sectionNamed(sections, name)
  if (section === undefined) loadFailed(`The segment "${key}" holds no section "${name}"`, { key, section: name })
  return section
}

function decodeResidentList(path: string, section: FileSection): unknown {
  const bytes = readWholeSectionChecked(path, section, false)
  try {
    return decode(bytes)
  } catch (error) {
    return loadFailed(
      `Section "${section.name}" of "${path}" is not MessagePack: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function checkedUint32s(path: string, section: FileSection, shared: boolean): Uint32Array {
  if (section.length % 4 !== 0) loadFailed(`Section "${section.name}" of "${path}" is not a whole number of values`)
  return uint32sFrom(readWholeSectionChecked(path, section, false), shared)
}

function readIdSample(path: string, section: FileSection, shared: boolean): { ids: string[]; positions: Uint32Array } {
  const raw = decodeResidentList(path, section)
  if (!Array.isArray(raw)) loadFailed(`Section "idSample" of "${path}" is not a list`)
  const ids: string[] = new Array(raw.length)
  const positions = shared ? new Uint32Array(new SharedArrayBuffer(raw.length * 4)) : new Uint32Array(raw.length)
  for (let at = 0; at < raw.length; at++) {
    const entry: unknown = raw[at]
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'number') {
      loadFailed(`Section "idSample" of "${path}" holds an invalid entry at ${at}`, { at })
    }
    ids[at] = entry[0]
    positions[at] = entry[1]
    if (at > 0 && positions[at] <= positions[at - 1]) {
      loadFailed(`Section "idSample" of "${path}" fails to ascend at entry ${at}`, { at })
    }
  }
  return { ids, positions }
}

export function readIdSampleOf(path: string, head: PagedSegmentHead): { ids: string[]; positions: Uint32Array } {
  return readIdSample(path, requireSection(head.sections, 'idSample', path), false)
}

function requireBlockLayout(
  lists: Uint32Array,
  offsets: Uint32Array,
  summaries: Uint8Array,
  postingOffsets: Uint32Array,
  tokenCount: number,
  key: string,
): void {
  if (summaries.byteLength % BLOCK_SUMMARY_BYTES !== 0) loadFailed(`The block summaries of "${key}" are cut short`)
  if (offsets.length !== lists.length + 1) loadFailed(`The block list offsets of "${key}" have the wrong length`)
  requireOffsets(offsets, summaries.byteLength / BLOCK_SUMMARY_BYTES, 'blockListOffsets')
  for (let at = 0; at < lists.length; at++) {
    const token = lists[at]
    if (at > 0 && token <= lists[at - 1]) loadFailed(`blockLists of "${key}" fails to ascend at entry ${at}`, { at })
    if (token >= tokenCount) loadFailed(`blockLists of "${key}" holds token ${token} of ${tokenCount}`, { at })
    if (postingOffsets[token + 1] - postingOffsets[token] <= SMALLEST_BLOCK_POSTINGS) {
      loadFailed(`blockLists of "${key}" lists token ${token}, which holds too few postings`, { token })
    }
  }
}

function requireDocumentBlockLayout(
  blocks: Uint8Array,
  documentCount: number,
  sectionLength: number,
  key: string,
): void {
  if (blocks.byteLength % DOCUMENT_BLOCK_BYTES !== 0) loadFailed(`The document blocks of "${key}" are cut short`)
  const view = new DataView(blocks.buffer, blocks.byteOffset, blocks.byteLength)
  const count = blocks.byteLength / DOCUMENT_BLOCK_BYTES
  let previousFirst = -1
  let previousEnd = 0
  for (let at = 0; at < count; at++) {
    const place = at * DOCUMENT_BLOCK_BYTES
    const first = view.getUint32(place, true)
    const offset = Number(view.getBigUint64(place + 4, true))
    const length = view.getUint32(place + 12, true)
    if (first <= previousFirst || first >= documentCount) loadFailed(`Document block ${at} of "${key}" starts wrongly`)
    if (offset !== previousEnd || offset + length > sectionLength) {
      loadFailed(`Document block ${at} of "${key}" lies outside its section`, { at })
    }
    previousFirst = first
    previousEnd = offset + length
  }
  if (documentCount > 0 && (count === 0 || view.getUint32(0, true) !== 0)) {
    loadFailed(`The document blocks of "${key}" fail to cover its documents`)
  }
}

export function vectorFieldsOfSchema(schema: Record<string, string>): string[] {
  return Object.keys(schema).filter(fieldPath => VECTOR_PATTERN.test(schema[fieldPath]))
}

export function openPagedSnapshot(listing: PagedFileListing): PagedSegmentSnapshot {
  const { head } = readPagedHead(listing)
  const { path, key } = listing
  const { sections, documentCount } = head
  const shared = sharedMemoryAvailable()
  const context: ColumnContext = { documentCount, shared }
  const take = (name: string): FileSection => requireSection(sections, name, key)

  const tokens = readWholeSectionChecked(path, take('tokens'), shared)
  const tokenOffsets = checkedUint32s(path, take('tokenOffsets'), shared)
  requireOffsets(tokenOffsets, tokens.length, 'tokenOffsets')
  requireUtf8Entries(tokens, tokenOffsets, 'tokens')
  requireEntriesAscend(tokens, tokenOffsets, null, 'tokens')
  const tokenCount = tokenOffsets.length - 1
  const documentFrequencies = checkedUint32s(path, take('documentFrequencies'), shared)
  const postingOffsets = checkedUint32s(path, take('postingOffsets'), shared)
  if (documentFrequencies.length !== tokenCount || postingOffsets.length !== tokenCount + 1) {
    loadFailed(`The token columns of "${key}" disagree on the token count`, { key })
  }
  const postingBytes = requireSection(sections, 'postings', key).length
  requireOffsets(postingOffsets, postingBytes / 8, 'postingOffsets')
  for (let token = 0; token < tokenCount; token++) {
    const postings = postingOffsets[token + 1] - postingOffsets[token]
    if (documentFrequencies[token] === 0 || documentFrequencies[token] > postings) {
      loadFailed(`documentFrequencies of "${key}" gives token ${token} a count of ${documentFrequencies[token]}`, {
        token,
      })
    }
  }
  const blockLists = checkedUint32s(path, take('blockLists'), shared)
  const blockListOffsets = checkedUint32s(path, take('blockListOffsets'), shared)
  const blockSummaries = readWholeSectionChecked(path, take('blockSummaries'), shared)
  requireBlockLayout(blockLists, blockListOffsets, blockSummaries, postingOffsets, tokenCount, key)
  const documentBlocks = readWholeSectionChecked(path, take('documentBlocks'), shared)
  requireDocumentBlockLayout(documentBlocks, documentCount, take('documents').length, key)
  const idSample = readIdSample(path, take('idSample'), shared)
  const lengths = decodeFieldLengths(decodeResidentList(path, take('fieldLengths')), context)
  const positionOffsetsSection = sectionNamed(sections, 'positionOffsets')
  const positionsSection = sectionNamed(sections, 'positions')
  if ((positionOffsetsSection === undefined) !== (positionsSection === undefined)) {
    loadFailed(`The segment "${key}" holds one of positionOffsets and positions`, { key })
  }
  return {
    segmentId: generateId(),
    key,
    path,
    tracksPositions: positionOffsetsSection !== undefined,
    schema: head.schema,
    discardedFields: vectorFieldsOfSchema(head.schema),
    sections,
    documentCount,
    fieldNames: head.fieldNames,
    ...lengths,
    tokenTable: {
      blob: tokens,
      offsets: tokenOffsets,
      payloadSlots: identitySlots(tokenCount, shared),
      documentFrequencies,
    },
    postingOffsets,
    blockLists,
    blockListOffsets,
    blockSummaries,
    documentBlocks,
    idSampleIds: idSample.ids,
    idSamplePositions: idSample.positions,
    numeric: decodeValueColumns(decodeResidentList(path, take('numeric')), 'numeric', context),
    sizes: decodeValueColumns(decodeResidentList(path, take('sizes')), 'sizes', context),
    boolean: decodeBooleanColumns(decodeResidentList(path, take('boolean')), context),
    enums: decodeEnumColumns(decodeResidentList(path, take('enum')), context),
    geo: decodeGeopointColumns(decodeResidentList(path, take('geopoint')), context),
    pattern: decodePatternColumns(decodeResidentList(path, take('pattern')), context),
    partialWords: decodePartialWords(decodeResidentList(path, take('partialWords')), tokenCount, context),
    tombstones: head.tombstones,
  }
}

export function residentBytesOf(snapshot: PagedSegmentSnapshot): number {
  const table = snapshot.tokenTable
  let bytes = table.blob.byteLength + table.offsets.byteLength
  bytes += table.payloadSlots.byteLength + table.documentFrequencies.byteLength
  bytes += snapshot.postingOffsets.byteLength + snapshot.blockLists.byteLength
  bytes += snapshot.blockListOffsets.byteLength + snapshot.blockSummaries.byteLength
  bytes += snapshot.documentBlocks.byteLength + snapshot.idSamplePositions.byteLength
  for (const id of snapshot.idSampleIds) bytes += id.length
  for (const id of snapshot.tombstones) bytes += id.length
  for (const column of snapshot.fieldLengthColumns) bytes += column.byteLength
  for (const entry of [...snapshot.numeric, ...snapshot.sizes])
    bytes += entry.docIds.byteLength + entry.values.byteLength
  for (const entry of snapshot.boolean) bytes += entry.trueDocs.byteLength + entry.falseDocs.byteLength
  for (const entry of snapshot.enums) bytes += entry.offsets.byteLength + entry.docIds.byteLength
  for (const entry of snapshot.geo) {
    bytes += entry.docIds.byteLength + entry.latitudes.byteLength + entry.longitudes.byteLength
  }
  for (const entry of snapshot.pattern) {
    bytes += entry.docIds.byteLength + entry.runs.byteLength + entry.offsets.byteLength + entry.postings.byteLength
  }
  const partial = snapshot.partialWords
  if (partial !== null) {
    bytes += partial.spellings.byteLength + partial.spellingOffsets.byteLength + partial.spellingTokens.byteLength
    bytes += partial.spellingCounts.byteLength + partial.runs.byteLength
    bytes += partial.runOffsets.byteLength + partial.runEntries.byteLength
  }
  return bytes
}
