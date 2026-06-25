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

export type SegmentHeaderCheck = { ok: true } | { ok: false; reason: string }

export function checkSegmentHeader(data: Uint8Array): SegmentHeaderCheck {
  if (data.length < SEGMENT_HEADER_SIZE) {
    return { ok: false, reason: 'segment shorter than the 8-byte header' }
  }
  for (let i = 0; i < WAL_MAGIC.length; i += 1) {
    if (data[i] !== WAL_MAGIC[i]) {
      return { ok: false, reason: 'missing NRSW magic' }
    }
  }
  const formatVersion = data[4]
  if (formatVersion > WAL_FORMAT_VERSION) {
    return {
      ok: false,
      reason: `WAL format version ${formatVersion} is newer than supported version ${WAL_FORMAT_VERSION}`,
    }
  }
  return { ok: true }
}

function decodeEntry(payload: Uint8Array): ReplicationLogEntry {
  const decoded = decode(payload)
  const validated = validateEntryPayload({ entry: decoded })
  return validated.entry
}

function corrupt(message: string, details: Record<string, unknown>): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_WAL_CORRUPT, message, details)
}

export function readDurableRegion(
  data: Uint8Array,
  durableByteLength: number,
  maxRecordBytes: number = MAX_WAL_RECORD_BYTES,
): ReplicationLogEntry[] {
  const header = checkSegmentHeader(data)
  if (!header.ok) {
    corrupt(`WAL segment header invalid in durable region: ${header.reason}`, { reason: header.reason })
  }
  if (durableByteLength < SEGMENT_HEADER_SIZE || durableByteLength > data.length) {
    corrupt('Commit marker durable byte length is outside the segment', {
      durableByteLength,
      segmentLength: data.length,
    })
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const entries: ReplicationLogEntry[] = []
  let offset = SEGMENT_HEADER_SIZE

  while (offset < durableByteLength) {
    if (offset + RECORD_LENGTH_SIZE > durableByteLength) {
      corrupt('WAL record length field overruns the durable region', { offset, durableByteLength })
    }
    const recordLength = view.getUint32(offset, false)
    if (recordLength === 0 || recordLength > maxRecordBytes) {
      corrupt('WAL record length is zero or exceeds the maximum record size', { offset, recordLength })
    }
    const payloadStart = offset + RECORD_LENGTH_SIZE
    const crcStart = payloadStart + recordLength
    const frameEnd = crcStart + FRAME_CRC_SIZE
    if (frameEnd > durableByteLength) {
      corrupt('WAL record overruns the durable region', { offset, frameEnd, durableByteLength })
    }
    const payload = data.subarray(payloadStart, crcStart)
    const storedCrc = view.getUint32(crcStart, false)
    if (crc32(payload) !== storedCrc) {
      corrupt('WAL record failed its frame checksum inside the durable region', { offset })
    }
    let entry: ReplicationLogEntry
    try {
      entry = decodeEntry(payload)
    } catch (err) {
      corrupt('WAL record payload failed to decode inside the durable region', {
        offset,
        cause: err instanceof Error ? err.message : String(err),
      })
    }
    if (entries.length > 0 && entry.seqNo <= entries[entries.length - 1].seqNo) {
      corrupt('WAL sequence numbers are not strictly increasing', {
        previousSeqNo: entries[entries.length - 1].seqNo,
        seqNo: entry.seqNo,
      })
    }
    entries.push(entry)
    offset = frameEnd
  }

  return entries
}
