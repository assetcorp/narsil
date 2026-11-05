import { crc32 } from '../../../serialization/crc32'
import { STORE_FRAME_LIMIT_BYTES } from '../constants'

const FRAME_HEADER_BYTES = 8

export function frameOf(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, payload.byteLength, false)
  view.setUint32(4, crc32(payload), false)
  frame.set(payload, FRAME_HEADER_BYTES)
  return frame
}

export interface ReadFrames {
  payloads: Uint8Array[]
  cleanLength: number
}

export function readFrames(bytes: Uint8Array): ReadFrames {
  const payloads: Uint8Array[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  while (at + FRAME_HEADER_BYTES <= bytes.byteLength) {
    const length = view.getUint32(at, false)
    const checksum = view.getUint32(at + 4, false)
    const end = at + FRAME_HEADER_BYTES + length
    if (length > STORE_FRAME_LIMIT_BYTES || end > bytes.byteLength) break
    const payload = bytes.subarray(at + FRAME_HEADER_BYTES, end)
    if (crc32(payload) !== checksum) break
    payloads.push(payload)
    at = end
  }
  return { payloads, cleanLength: at }
}
