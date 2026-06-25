import { decode, encode } from '@msgpack/msgpack'
import { validateEntryPayload } from '../../distribution/replication/codec'
import type { ReplicationLogEntry } from '../../distribution/replication/types'
import { ErrorCodes, NarsilError } from '../../errors'
import { crc32 } from './checksum'

export const WAL_MAGIC = new Uint8Array([0x4e, 0x52, 0x53, 0x57])
export const WAL_FORMAT_VERSION = 1
export const SEGMENT_HEADER_SIZE = 8
export const RECORD_LENGTH_SIZE = 4
export const FRAME_CRC_SIZE = 4

export const MAX_WAL_RECORD_BYTES = 268_435_456

export function writeSegmentHeader(): Uint8Array {
  const header = new Uint8Array(SEGMENT_HEADER_SIZE)
  header.set(WAL_MAGIC, 0)
  header[4] = WAL_FORMAT_VERSION & 0xff
  return header
}

export function frameRecord(entry: ReplicationLogEntry): Uint8Array {
  const payload = encode(entry)
  const frame = new Uint8Array(RECORD_LENGTH_SIZE + payload.length + FRAME_CRC_SIZE)
  const view = new DataView(frame.buffer)
  view.setUint32(0, payload.length, false)
  frame.set(payload, RECORD_LENGTH_SIZE)
  view.setUint32(RECORD_LENGTH_SIZE + payload.length, crc32(payload), false)
  return frame
}

export type WalReadResult =
  | { kind: 'header-invalid'; reason: string }
  | { kind: 'records'; entries: ReplicationLogEntry[]; cleanByteLength: number; truncated: boolean }

interface ParsedRecord {
  entry: ReplicationLogEntry
  endOffset: number
}

function decodeEntry(payload: Uint8Array): ReplicationLogEntry {
  const decoded = decode(payload)
  const validated = validateEntryPayload({ entry: decoded })
  return validated.entry
}

export function readSegment(data: Uint8Array, maxRecordBytes: number = MAX_WAL_RECORD_BYTES): WalReadResult {
  if (data.length < SEGMENT_HEADER_SIZE) {
    return { kind: 'header-invalid', reason: 'segment shorter than the 8-byte header' }
  }
  for (let i = 0; i < WAL_MAGIC.length; i += 1) {
    if (data[i] !== WAL_MAGIC[i]) {
      return { kind: 'header-invalid', reason: 'missing NRSW magic' }
    }
  }
  const formatVersion = data[4]
  if (formatVersion > WAL_FORMAT_VERSION) {
    return {
      kind: 'header-invalid',
      reason: `WAL format version ${formatVersion} is newer than supported version ${WAL_FORMAT_VERSION}`,
    }
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const entries: ReplicationLogEntry[] = []
  let offset = SEGMENT_HEADER_SIZE
  let cleanByteLength = SEGMENT_HEADER_SIZE
  let truncated = false

  for (;;) {
    const parsed = parseRecord(data, view, offset, maxRecordBytes)
    if (parsed === 'clean-end') {
      break
    }
    if (parsed === 'torn') {
      truncated = true
      break
    }
    if (parsed === 'corrupt') {
      const hasValidAfter = scanForValidRecordAfter(data, view, offset, maxRecordBytes)
      if (hasValidAfter) {
        throw new NarsilError(
          ErrorCodes.PERSISTENCE_WAL_CORRUPT,
          'WAL record failed its frame checksum with valid records following it (mid-log corruption)',
          { offset },
        )
      }
      truncated = true
      break
    }
    entries.push(parsed.entry)
    offset = parsed.endOffset
    cleanByteLength = parsed.endOffset
  }

  enforceMonotonicSeqNo(entries)
  return { kind: 'records', entries, cleanByteLength, truncated }
}

function parseRecord(
  data: Uint8Array,
  view: DataView,
  offset: number,
  maxRecordBytes: number,
): ParsedRecord | 'clean-end' | 'torn' | 'corrupt' {
  if (offset + RECORD_LENGTH_SIZE > data.length) {
    return 'clean-end'
  }
  const recordLength = view.getUint32(offset, false)
  if (recordLength === 0 || recordLength > maxRecordBytes) {
    return 'torn'
  }
  const payloadStart = offset + RECORD_LENGTH_SIZE
  const crcStart = payloadStart + recordLength
  const frameEnd = crcStart + FRAME_CRC_SIZE
  if (frameEnd > data.length) {
    return 'torn'
  }
  const payload = data.subarray(payloadStart, crcStart)
  const storedCrc = view.getUint32(crcStart, false)
  if (crc32(payload) !== storedCrc) {
    return 'corrupt'
  }
  let entry: ReplicationLogEntry
  try {
    entry = decodeEntry(payload)
  } catch {
    return 'corrupt'
  }
  return { entry, endOffset: frameEnd }
}

function scanForValidRecordAfter(data: Uint8Array, view: DataView, badOffset: number, maxRecordBytes: number): boolean {
  const recordLength = badOffset + RECORD_LENGTH_SIZE <= data.length ? view.getUint32(badOffset, false) : 0
  if (recordLength === 0 || recordLength > maxRecordBytes) {
    return false
  }
  const nextOffset = badOffset + RECORD_LENGTH_SIZE + recordLength + FRAME_CRC_SIZE
  if (nextOffset >= data.length) {
    return false
  }
  const next = parseRecord(data, view, nextOffset, maxRecordBytes)
  return next !== 'clean-end' && next !== 'torn' && next !== 'corrupt'
}

function enforceMonotonicSeqNo(entries: ReplicationLogEntry[]): void {
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].seqNo <= entries[i - 1].seqNo) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_WAL_CORRUPT,
        'WAL sequence numbers are not strictly increasing (mid-log corruption)',
        { previousSeqNo: entries[i - 1].seqNo, seqNo: entries[i].seqNo },
      )
    }
  }
}
