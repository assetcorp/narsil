import { encode } from '@msgpack/msgpack'
import type { ServerMessage } from '../protocol'

const FIXARRAY_LIMIT = 16
const ARRAY16_LIMIT = 65_536
const FIXARRAY_TAG = 0x90
const ARRAY16_TAG = 0xdc
const ARRAY32_TAG = 0xdd
const FIXMAP_OF_THREE = 0x83

const entriesKeyPrefix = (() => {
  const parts = [Uint8Array.of(FIXMAP_OF_THREE), encode('type'), encode('entries'), encode('partitionId')]
  return concat(parts)
})()
const entriesKey = encode('entries')

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.byteLength
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

function arrayHeader(count: number): Uint8Array {
  if (count < FIXARRAY_LIMIT) return Uint8Array.of(FIXARRAY_TAG | count)
  if (count < ARRAY16_LIMIT) return Uint8Array.of(ARRAY16_TAG, count >>> 8, count & 0xff)
  return Uint8Array.of(ARRAY32_TAG, count >>> 24, (count >>> 16) & 0xff, (count >>> 8) & 0xff, count & 0xff)
}

export function encodeEntriesMessage(partitionId: number, payloads: readonly Uint8Array[]): Uint8Array {
  return concat([entriesKeyPrefix, encode(partitionId), entriesKey, arrayHeader(payloads.length), ...payloads])
}

export function encodeServerMessage(message: Exclude<ServerMessage, { type: 'entries' }>): Uint8Array {
  return encode(message, { ignoreUndefined: true })
}
