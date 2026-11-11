import type { FormContext } from './codec'
import { FormError, mapOf } from './decoded'
import { type Json, type JsonObject, tagged } from './json'

const WAL_MAGIC = [0x4e, 0x52, 0x53, 0x57]
const SEGMENT_HEADER_BYTES = 8
const RECORD_LENGTH_BYTES = 4
const FRAME_CRC_BYTES = 4
const ENTRY_PLACEMENT_KEYS = new Set(['checksum'])
const PREVIOUS_DOCUMENT_KEY = 'previousDocument'
const DOCUMENT_KEYS = new Set(['document', PREVIOUS_DOCUMENT_KEY])
const MARKER_SLOT_BYTES = 36
const MARKER_SLOTS = 2
const MARKER_CRC_OFFSET = 32
const MARKER_FIELDS = ['writeSeq', 'activeSegmentSeqNo', 'durableByteLength', 'highestDurableSeqNo'] as const

function recordJson(payload: Uint8Array, context: FormContext, what: string): JsonObject {
  const entry = mapOf(context.unpack(payload, what), what)
  const object: JsonObject = {}
  for (const [key, value] of entry) {
    if (ENTRY_PLACEMENT_KEYS.has(key)) continue
    if (!DOCUMENT_KEYS.has(key)) {
      object[key] = tagged(value)
      continue
    }
    if (value === null) {
      if (key === PREVIOUS_DOCUMENT_KEY) object[key] = null
      continue
    }
    if (!(value instanceof Uint8Array)) throw new FormError(`${what}.${key} is not a binary value`)
    object[key] = tagged(context.unpack(value, `${what}.${key}`))
  }
  return object
}

export function logSegmentJson(bytes: Uint8Array, context: FormContext, what: string): JsonObject {
  if (bytes.byteLength < SEGMENT_HEADER_BYTES || WAL_MAGIC.some((byte, at) => bytes[at] !== byte)) {
    throw new FormError(`${what} does not begin with the NRSW header`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const records: Json[] = []
  let offset = SEGMENT_HEADER_BYTES
  while (offset < bytes.byteLength) {
    if (offset + RECORD_LENGTH_BYTES > bytes.byteLength) throw new FormError(`${what} ends inside a record length`)
    const length = view.getUint32(offset, false)
    const start = offset + RECORD_LENGTH_BYTES
    const end = start + length
    if (length === 0 || end + FRAME_CRC_BYTES > bytes.byteLength) {
      throw new FormError(`${what} holds a record at byte ${offset} that overruns the file`)
    }
    const payload = bytes.subarray(start, end)
    if (context.crc32(payload) !== view.getUint32(end, false)) {
      throw new FormError(`${what} holds a record at byte ${offset} that fails its frame checksum`)
    }
    records.push(recordJson(payload, context, `${what} record ${records.length}`))
    offset = end + FRAME_CRC_BYTES
  }
  return { walFormatVersion: bytes[4], records }
}

function slotJson(slot: Uint8Array, context: FormContext): Json {
  const view = new DataView(slot.buffer, slot.byteOffset, slot.byteLength)
  if (context.crc32(slot.subarray(0, MARKER_CRC_OFFSET)) !== view.getUint32(MARKER_CRC_OFFSET, false)) return null
  const object: JsonObject = {}
  MARKER_FIELDS.forEach((field, at) => {
    const value = view.getBigUint64(at * 8, false)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new FormError(`a marker slot holds ${field} ${value}`)
    object[field] = Number(value)
  })
  return object
}

export function commitMarkerJson(bytes: Uint8Array, context: FormContext, what: string): JsonObject {
  if (bytes.byteLength !== MARKER_SLOT_BYTES * MARKER_SLOTS) {
    throw new FormError(`${what} holds ${bytes.byteLength} bytes, while a commit marker holds 72`)
  }
  const slots: Json[] = []
  for (let slot = 0; slot < MARKER_SLOTS; slot++) {
    slots.push(slotJson(bytes.subarray(slot * MARKER_SLOT_BYTES, (slot + 1) * MARKER_SLOT_BYTES), context))
  }
  return { slots }
}
