import { crc32 } from '../serialization/crc32'
import { openChecksummedEnvelope, packEnvelopeWithChecksum } from '../serialization/envelope-file'
import { HEADER_SIZE } from '../serialization/header'
import { KEY_FINGERPRINT_BYTES, MAX_HISTORY_FILE_BYTES, MAX_INDEX_UUID_LENGTH, SCRAMBLED_ID_BYTES } from './constants'
import { type CountsPeople, type PhraseVisitor, walkGroups } from './counts-groups'
import type { DayCounts } from './day-counts'
import {
  binarySize,
  containerHeaderSize,
  ExactWriter,
  MalformedPayload,
  StrictReader,
  stringSize,
  uintSize,
} from './msgpack-cursor'

export type { CountsPeople, PhraseVisitor }

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const WHAT = 'query counts file'
const QUERY_COUNTS_FILE_FORMAT_VERSION = 1

const KEY_DAY = 'day'
const KEY_FINGERPRINT = 'keyFingerprint'
const KEY_SAVED_AT = 'savedAt'
const KEY_INDEX_UUID = 'indexUuid'
const KEY_GROUPS = 'groups'
const KEY_PHRASE = 'phrase'
const KEY_COUNT = 'count'
const KEY_PEOPLE = 'people'
const REQUIRED_TOP_LEVEL_KEYS = 4
const PHRASE_KEYS = 3

export interface CountsFileHeader {
  day: string
  fingerprint: Uint8Array
  savedAt: number
  indexUuid: string | null
}

export interface OpenedCounts extends CountsFileHeader {
  kind: 'counts'
  visit(visitor: PhraseVisitor): void
  groupNames(): string[]
  withIndexUuid(indexUuid: string | null, savedAt: number): Uint8Array
}

export type OpenedCountsFile = OpenedCounts | { kind: 'damaged'; reason: string } | { kind: 'other-key' }

export function isDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function topLevelSize(header: CountsFileHeader): number {
  const keys = REQUIRED_TOP_LEVEL_KEYS + (header.indexUuid === null ? 0 : 1)
  return (
    containerHeaderSize(keys) +
    stringSize(KEY_DAY) +
    stringSize(header.day) +
    stringSize(KEY_FINGERPRINT) +
    binarySize(header.fingerprint.byteLength) +
    stringSize(KEY_SAVED_AT) +
    uintSize(header.savedAt) +
    (header.indexUuid === null ? 0 : stringSize(KEY_INDEX_UUID) + stringSize(header.indexUuid)) +
    stringSize(KEY_GROUPS)
  )
}

function writeTopLevel(writer: ExactWriter, header: CountsFileHeader): void {
  writer.map(REQUIRED_TOP_LEVEL_KEYS + (header.indexUuid === null ? 0 : 1))
  writer.string(KEY_DAY)
  writer.string(header.day)
  writer.string(KEY_FINGERPRINT)
  writer.binary(header.fingerprint, 0, header.fingerprint.byteLength)
  writer.string(KEY_SAVED_AT)
  writer.uint(header.savedAt)
  if (header.indexUuid !== null) {
    writer.string(KEY_INDEX_UUID)
    writer.string(header.indexUuid)
  }
  writer.string(KEY_GROUPS)
}

function groupsSize(counts: DayCounts): number {
  let size = containerHeaderSize(counts.groupTables.size)
  for (const [group, phrases] of counts.groupTables) {
    size += stringSize(group) + containerHeaderSize(phrases.size)
    for (const [phrase, number] of phrases) {
      const people = counts.peopleLengthOf(number)
      size +=
        containerHeaderSize(PHRASE_KEYS) +
        stringSize(KEY_PHRASE) +
        stringSize(phrase) +
        stringSize(KEY_COUNT) +
        uintSize(counts.countOf(number)) +
        stringSize(KEY_PEOPLE) +
        containerHeaderSize(people) +
        people * binarySize(SCRAMBLED_ID_BYTES)
    }
  }
  return size
}

function writeGroups(writer: ExactWriter, counts: DayCounts): void {
  writer.map(counts.groupTables.size)
  const people = counts.peopleBytes
  for (const [group, phrases] of counts.groupTables) {
    writer.string(group)
    writer.array(phrases.size)
    for (const [phrase, number] of phrases) {
      writer.map(PHRASE_KEYS)
      writer.string(KEY_PHRASE)
      writer.string(phrase)
      writer.string(KEY_COUNT)
      writer.uint(counts.countOf(number))
      writer.string(KEY_PEOPLE)
      const length = counts.peopleLengthOf(number)
      const offset = counts.peopleOffsetOf(number)
      writer.array(length)
      for (let i = 0; i < length; i++) writer.binary(people, offset + i * SCRAMBLED_ID_BYTES, SCRAMBLED_ID_BYTES)
    }
  }
}

function sealed(bytes: Uint8Array, writer: ExactWriter): Uint8Array {
  if (writer.offset !== bytes.byteLength) throw new MalformedPayload('The query counts file took an unexpected size')
  if (bytes.byteLength > MAX_HISTORY_FILE_BYTES) {
    throw new MalformedPayload(`A query counts file must stay at or below ${MAX_HISTORY_FILE_BYTES} bytes`)
  }
  const payload = bytes.subarray(HEADER_SIZE)
  const packed = packEnvelopeWithChecksum([payload], QUERY_COUNTS_FILE_FORMAT_VERSION, WHAT, crc32(payload))
  bytes.set(packed.chunks[0], 0)
  return bytes
}

export function encodeCountsFile(counts: DayCounts, header: Omit<CountsFileHeader, 'day'>): Uint8Array {
  const full: CountsFileHeader = { ...header, day: counts.day }
  const bytes = new Uint8Array(HEADER_SIZE + topLevelSize(full) + groupsSize(counts))
  const writer = new ExactWriter(bytes, HEADER_SIZE)
  writeTopLevel(writer, full)
  writeGroups(writer, counts)
  return sealed(bytes, writer)
}

function rewrittenFile(header: CountsFileHeader, groups: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(HEADER_SIZE + topLevelSize(header) + groups.byteLength)
  const writer = new ExactWriter(bytes, HEADER_SIZE)
  writeTopLevel(writer, header)
  bytes.set(groups, writer.offset)
  writer.skip(groups.byteLength)
  return sealed(bytes, writer)
}

interface TopLevel extends CountsFileHeader {
  groupsStart: number
  groupsEnd: number
}

function readTopLevel(payload: Uint8Array): TopLevel {
  const reader = new StrictReader(payload, 0)
  const keys = reader.map()
  let day: string | null = null
  let fingerprint: Uint8Array | null = null
  let savedAt: number | null = null
  let indexUuid: string | null = null
  let groupsStart: number | null = null
  let groupsEnd = 0
  const seen = new Set<string>()
  for (let i = 0; i < keys; i++) {
    const key = reader.string()
    if (seen.has(key)) throw new MalformedPayload(`The file holds the key "${key}" twice`)
    seen.add(key)
    if (key === KEY_DAY) day = reader.string()
    else if (key === KEY_FINGERPRINT) {
      const { offset, length } = reader.binary()
      fingerprint = payload.subarray(offset, offset + length)
    } else if (key === KEY_SAVED_AT) savedAt = reader.uint()
    else if (key === KEY_INDEX_UUID) {
      indexUuid = reader.string()
      if (indexUuid.length === 0 || indexUuid.length > MAX_INDEX_UUID_LENGTH) {
        throw new MalformedPayload('The file holds an indexUuid of the wrong length')
      }
    } else if (key === KEY_GROUPS) {
      groupsStart = reader.offset
      walkGroups(reader, payload, null)
      groupsEnd = reader.offset
    } else throw new MalformedPayload(`The file holds an unexpected key "${key}"`)
  }
  if (!reader.atEnd) throw new MalformedPayload('The payload holds bytes after its map')
  if (day === null || fingerprint === null || savedAt === null || groupsStart === null) {
    throw new MalformedPayload('The file lacks a required key')
  }
  return { day, fingerprint, savedAt, indexUuid, groupsStart, groupsEnd }
}

export async function openCountsFile(
  bytes: Uint8Array,
  expectedDay: string | null,
  fingerprint: Uint8Array,
): Promise<OpenedCountsFile> {
  if (bytes.byteLength > MAX_HISTORY_FILE_BYTES) {
    return { kind: 'damaged', reason: `The file is longer than ${MAX_HISTORY_FILE_BYTES} bytes` }
  }
  let payload: Uint8Array
  try {
    payload = (
      await openChecksummedEnvelope(bytes, {
        envelopeFormatVersion: QUERY_COUNTS_FILE_FORMAT_VERSION,
        what: WHAT,
        allowsCompression: false,
      })
    ).payload
  } catch (error) {
    return { kind: 'damaged', reason: error instanceof Error ? error.message : String(error) }
  }
  let top: TopLevel
  try {
    top = readTopLevel(payload)
  } catch (error) {
    if (error instanceof MalformedPayload) return { kind: 'damaged', reason: error.message }
    throw error
  }
  if (!isDay(top.day) || (expectedDay !== null && top.day !== expectedDay)) {
    return { kind: 'damaged', reason: 'The file holds a day that differs from its key' }
  }
  if (top.fingerprint.byteLength !== KEY_FINGERPRINT_BYTES) {
    return { kind: 'damaged', reason: 'The key fingerprint has the wrong length' }
  }
  if (!sameBytes(top.fingerprint, fingerprint)) return { kind: 'other-key' }
  const { groupsStart, groupsEnd, ...header } = top
  return {
    kind: 'counts',
    ...header,
    visit(visitor) {
      walkGroups(new StrictReader(payload, groupsStart), payload, visitor)
    },
    groupNames() {
      const names: string[] = []
      walkGroups(new StrictReader(payload, groupsStart), payload, null, group => names.push(group))
      return names
    },
    withIndexUuid(indexUuid, savedAt) {
      return rewrittenFile({ ...header, indexUuid, savedAt }, payload.subarray(groupsStart, groupsEnd))
    },
  }
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let i = 0; i < left.byteLength; i++) if (left[i] !== right[i]) return false
  return true
}
