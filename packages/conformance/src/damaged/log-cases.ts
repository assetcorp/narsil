import { decode } from '@msgpack/msgpack'
import { crc32 } from '../../../ts/src/serialization/crc32'
import { joined } from '../reference/envelope'
import { type CaseBuild, damagedCheckpoint } from './build'
import { baseFile, mapAt, otherChecksum } from './bytes'

const INDEX = 'products'
const SEGMENT = 'wal/0/0000000000000046'
const MARKER = 'wal/0/commit'
const SEGMENT_HEADER_BYTES = 8
const FRAME_LENGTH_BYTES = 4
const FRAME_CRC_BYTES = 4
const SLOT_BYTES = 36
const SLOT_CRC_OFFSET = 32
const DURABLE_LENGTH_OFFSET = 16
const HIGHEST_DURABLE_OFFSET = 24
const WAL_CORRUPT = 'PERSISTENCE_WAL_CORRUPT'
const RULE = 'durability.md#reading-a-segment'
const UNDECODABLE_MESSAGEPACK = 0xc1
const FIXSTR_TAG = 0xa0
const POSITIVE_FIXINT_MAX = 0x7f
const UINT_WIDTHS = new Map([
  [0xcc, 1],
  [0xcd, 2],
  [0xce, 4],
  [0xcf, 8],
])

interface LogFiles {
  header: Uint8Array
  payloads: Uint8Array[]
  marker: Uint8Array
}

async function logFiles(): Promise<LogFiles> {
  const segment = await baseFile(INDEX, SEGMENT)
  const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
  const payloads: Uint8Array[] = []
  for (let at = SEGMENT_HEADER_BYTES; at < segment.byteLength; ) {
    const length = view.getUint32(at, false)
    payloads.push(segment.slice(at + FRAME_LENGTH_BYTES, at + FRAME_LENGTH_BYTES + length))
    at += FRAME_LENGTH_BYTES + length + FRAME_CRC_BYTES
  }
  return { header: segment.slice(0, SEGMENT_HEADER_BYTES), payloads, marker: await baseFile(INDEX, MARKER) }
}

function frame(payload: Uint8Array, crc = crc32(payload)): Uint8Array {
  const bytes = new Uint8Array(FRAME_LENGTH_BYTES + payload.byteLength + FRAME_CRC_BYTES)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, payload.byteLength, false)
  bytes.set(payload, FRAME_LENGTH_BYTES)
  view.setUint32(FRAME_LENGTH_BYTES + payload.byteLength, crc, false)
  return bytes
}

function segmentOf(header: Uint8Array, frames: readonly Uint8Array[]): Uint8Array {
  return joined([header, ...frames])
}

function newestSlot(marker: Uint8Array): number {
  const view = new DataView(marker.buffer, marker.byteOffset, marker.byteLength)
  return view.getBigUint64(0, false) >= view.getBigUint64(SLOT_BYTES, false) ? 0 : 1
}

function markerWith(marker: Uint8Array, change: (slot: DataView) => void): Uint8Array {
  const copy = marker.slice()
  const start = newestSlot(copy) * SLOT_BYTES
  const slot = new DataView(copy.buffer, start, SLOT_BYTES)
  change(slot)
  slot.setUint32(SLOT_CRC_OFFSET, crc32(copy.subarray(start, start + SLOT_CRC_OFFSET)), false)
  return copy
}

function markerFrontier(marker: Uint8Array, length: number): Uint8Array {
  return markerWith(marker, slot => slot.setBigUint64(DURABLE_LENGTH_OFFSET, BigInt(length), false))
}

function valueWidthAt(payload: Uint8Array, at: number): number {
  const tag = payload[at] ?? 0
  if (tag <= POSITIVE_FIXINT_MAX) return 1
  const width = UINT_WIDTHS.get(tag)
  if (width === undefined) throw new Error(`the log entry checksum has the MessagePack tag ${tag}`)
  return 1 + width
}

function withOtherEntryChecksum(payload: Uint8Array): Uint8Array {
  if (typeof mapAt(decode(payload), 'log entry').checksum !== 'number') throw new Error('the log entry has no checksum')
  const key = new TextEncoder().encode('checksum')
  const start = payload.findLastIndex(
    (byte, at) => byte === FIXSTR_TAG + key.length && key.every((value, k) => payload[at + 1 + k] === value),
  )
  if (start < 0) throw new Error('the log entry checksum key is missing')
  const valueAt = start + 1 + key.length
  const last = valueAt + valueWidthAt(payload, valueAt) - 1
  const copy = payload.slice()
  copy[last] = (copy[last] ?? 0) ^ 0x01
  return copy
}

function logCase(name: string, code: string, files: LogFiles, frames: Uint8Array[], marker?: Uint8Array) {
  const segment = segmentOf(files.header, frames)
  return damagedCheckpoint(name, RULE, code, INDEX, {
    [SEGMENT]: segment,
    [MARKER]: marker ?? markerFrontier(files.marker, segment.byteLength),
  })
}

export async function logCases(): Promise<CaseBuild[]> {
  const files = await logFiles()
  const frames = files.payloads.map(payload => frame(payload))
  const [first, second] = files.payloads
  if (first === undefined || second === undefined) throw new Error('the log segment holds fewer than two records')
  const rest = frames.slice(2)
  const wrongMagic = files.header.slice()
  wrongMagic[3] = 0x58
  const newerVersion = files.header.slice()
  newerVersion[4] = 2
  const segment = segmentOf(files.header, frames)
  const overrun = frame(first)
  new DataView(overrun.buffer).setUint32(0, segment.byteLength, false)
  const undecodable = new Uint8Array([UNDECODABLE_MESSAGEPACK, ...first.subarray(1)])
  const torn = frame(first).subarray(0, FRAME_LENGTH_BYTES + 10)
  const tornMarker = files.marker.slice()
  const tornSlot = newestSlot(tornMarker) * SLOT_BYTES + 8
  tornMarker[tornSlot] = (tornMarker[tornSlot] ?? 0) ^ 0x01
  return [
    damagedCheckpoint('log-magic', 'durability.md#segment-header', WAL_CORRUPT, INDEX, {
      [SEGMENT]: segmentOf(wrongMagic, frames),
    }),
    damagedCheckpoint('log-format-version-newer', 'durability.md#segment-header', 'ENVELOPE_VERSION_MISMATCH', INDEX, {
      [SEGMENT]: segmentOf(newerVersion, frames),
    }),
    logCase('log-record-overruns-frontier', WAL_CORRUPT, files, [overrun, ...frames.slice(1)], files.marker),
    logCase('log-frame-checksum', WAL_CORRUPT, files, [frame(first, otherChecksum(crc32(first))), ...frames.slice(1)]),
    logCase('log-payload-undecodable', WAL_CORRUPT, files, [frame(undecodable), ...frames.slice(1)]),
    logCase('log-entry-checksum', WAL_CORRUPT, files, [frame(withOtherEntryChecksum(first)), ...frames.slice(1)]),
    logCase('log-seq-no-out-of-order', WAL_CORRUPT, files, [frame(second), frame(first), ...rest]),
    damagedCheckpoint('log-short-of-highest-durable', RULE, WAL_CORRUPT, INDEX, {
      [MARKER]: markerWith(files.marker, slot =>
        slot.setBigUint64(HIGHEST_DURABLE_OFFSET, slot.getBigUint64(HIGHEST_DURABLE_OFFSET, false) + 1n, false),
      ),
    }),
    damagedCheckpoint('log-torn-tail-past-frontier', RULE, null, INDEX, {
      [SEGMENT]: joined([segment, torn]),
    }),
    damagedCheckpoint('log-torn-marker-slot', 'durability.md#commit-marker', null, INDEX, {
      [MARKER]: tornMarker,
    }),
  ]
}
