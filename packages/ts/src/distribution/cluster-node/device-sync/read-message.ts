import { encode } from '@msgpack/msgpack'
import type { LogFrame } from '../../../persistence/durability/sync/frame-cursor'
import { isRecord, isValidInteger } from '../../payload-guards'
import { SyncMessageTypes, type TransportMessage } from '../../transport/types'

export interface SyncReadRequest {
  indexName: string
  indexUuid: string
  partitionId: number
  afterSeqNo: number
  maxBytes: number
}

export interface SyncReadReply {
  frames: LogFrame[]
  head: number
  highestSeqNo: number
  oldestSeqNo: number
  bytesBehind: number
}

const UINT32_MAX = 0xffff_ffff
const FIXMAP_OF_FIVE = 0x85
const FIXARRAY_LIMIT = 16
const ARRAY16_LIMIT = 65_536

function isSeqNo(value: unknown): value is number {
  return isValidInteger(value) && value >= 0
}

export function validateSyncReadRequest(decoded: unknown): SyncReadRequest | null {
  if (!isRecord(decoded)) return null
  const { indexName, indexUuid, partitionId, afterSeqNo, maxBytes } = decoded
  if (typeof indexName !== 'string' || indexName.length === 0) return null
  if (typeof indexUuid !== 'string' || indexUuid.length === 0) return null
  if (!isValidInteger(partitionId) || partitionId < 0 || partitionId > UINT32_MAX) return null
  if (!isSeqNo(afterSeqNo)) return null
  if (!isValidInteger(maxBytes) || maxBytes < 1 || maxBytes > UINT32_MAX) return null
  return { indexName, indexUuid, partitionId, afterSeqNo, maxBytes }
}

export function createSyncReadMessage(request: SyncReadRequest, sourceId: string, requestId: string): TransportMessage {
  return { type: SyncMessageTypes.READ, sourceId, requestId, payload: encode(request) }
}

function arrayHeader(count: number): Uint8Array {
  if (count < FIXARRAY_LIMIT) return Uint8Array.of(0x90 | count)
  if (count < ARRAY16_LIMIT) return Uint8Array.of(0xdc, count >>> 8, count & 0xff)
  return Uint8Array.of(0xdd, count >>> 24, (count >>> 16) & 0xff, (count >>> 8) & 0xff, count & 0xff)
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

export function encodeSyncReadReply(reply: SyncReadReply): Uint8Array {
  return concat([
    Uint8Array.of(FIXMAP_OF_FIVE),
    encode('entries'),
    arrayHeader(reply.frames.length),
    ...reply.frames.map(frame => frame.payload),
    encode('head'),
    encode(reply.head),
    encode('highestSeqNo'),
    encode(reply.highestSeqNo),
    encode('oldestSeqNo'),
    encode(reply.oldestSeqNo),
    encode('bytesBehind'),
    encode(reply.bytesBehind),
  ])
}

export function decodeSyncReadReply(decoded: unknown, partitionId: number, afterSeqNo: number): SyncReadReply | null {
  if (!isRecord(decoded) || !Array.isArray(decoded.entries)) return null
  const { head, highestSeqNo, oldestSeqNo, bytesBehind } = decoded
  if (!isSeqNo(head) || !isSeqNo(highestSeqNo) || !isSeqNo(oldestSeqNo) || !isSeqNo(bytesBehind)) return null
  const frames: LogFrame[] = []
  let previous = afterSeqNo
  for (const entry of decoded.entries) {
    if (!isRecord(entry) || !isSeqNo(entry.seqNo) || entry.seqNo <= previous || entry.seqNo > head) return null
    if (entry.partitionId !== partitionId) return null
    const payload = encode(entry)
    frames.push({ seqNo: entry.seqNo, payload, frameBytes: payload.byteLength })
    previous = entry.seqNo
  }
  return { frames, head, highestSeqNo, oldestSeqNo, bytesBehind }
}
