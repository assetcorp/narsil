import { encode } from '#platform/storage-host'
import type { DerivedChange } from './derive'

const FIXMAP_TAG = 0x80
const FIXARRAY_LIMIT = 16
const ARRAY16_LIMIT = 65_536
const FIXARRAY_TAG = 0x90
const ARRAY16_TAG = 0xdc
const ARRAY32_TAG = 0xdd
const CHANGES_MESSAGE_KEY_COUNT = 4
const CHANGE_FIXED_KEY_COUNT = 3

let keys: Record<string, Uint8Array> | null = null

function keyBytes(name: string): Uint8Array {
  keys ??= {}
  let bytes = keys[name]
  if (bytes === undefined) {
    bytes = encode(name)
    keys[name] = bytes
  }
  return bytes
}

function arrayHeader(count: number): Uint8Array {
  if (count < FIXARRAY_LIMIT) return Uint8Array.of(FIXARRAY_TAG | count)
  if (count < ARRAY16_LIMIT) return Uint8Array.of(ARRAY16_TAG, count >>> 8, count & 0xff)
  return Uint8Array.of(ARRAY32_TAG, count >>> 24, (count >>> 16) & 0xff, (count >>> 8) & 0xff, count & 0xff)
}

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

export function encodedChangeParts(change: DerivedChange): Uint8Array[] {
  const keyCount =
    CHANGE_FIXED_KEY_COUNT + (change.document === null ? 0 : 1) + (change.previousDocument === null ? 0 : 1)
  const parts = [
    Uint8Array.of(FIXMAP_TAG | keyCount),
    keyBytes('seqNo'),
    encode(change.seqNo),
    keyBytes('type'),
    keyBytes(change.type),
    keyBytes('documentId'),
    encode(change.documentId),
  ]
  if (change.document !== null) parts.push(keyBytes('document'), change.document)
  if (change.previousDocument !== null) parts.push(keyBytes('previousDocument'), change.previousDocument)
  return parts
}

export function encodeChangesMessage(
  partitionId: number,
  changes: readonly DerivedChange[],
  scannedSeqNo: number,
): Uint8Array {
  const parts: Uint8Array[] = [
    Uint8Array.of(FIXMAP_TAG | CHANGES_MESSAGE_KEY_COUNT),
    keyBytes('type'),
    keyBytes('changes'),
    keyBytes('partitionId'),
    encode(partitionId),
    keyBytes('scannedSeqNo'),
    encode(scannedSeqNo),
    keyBytes('changes'),
    arrayHeader(changes.length),
  ]
  for (const change of changes) parts.push(...encodedChangeParts(change))
  return concat(parts)
}

export function encodeFeedMessage(message: Record<string, unknown>): Uint8Array {
  return encode(message, { ignoreUndefined: true })
}
