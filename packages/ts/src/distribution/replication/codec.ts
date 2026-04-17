import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import type {
  AckPayload,
  EntryPayload,
  ForwardPayload,
  InsyncConfirmPayload,
  InsyncRemovePayload,
  TransportMessage,
} from '../transport/types'
import { ReplicationMessageTypes } from '../transport/types'
import type { ReplicationLogEntry } from './types'

export function createEntryMessage(entry: ReplicationLogEntry, sourceId: string): TransportMessage {
  const payload: EntryPayload = { entry }
  return {
    type: ReplicationMessageTypes.ENTRY,
    sourceId,
    requestId: generateId(),
    payload: encode(payload),
  }
}

export function createAckMessage(
  seqNo: number,
  partitionId: number,
  indexName: string,
  sourceId: string,
  requestId: string,
): TransportMessage {
  const payload: AckPayload = { seqNo, partitionId, indexName }
  return {
    type: ReplicationMessageTypes.ACK,
    sourceId,
    requestId,
    payload: encode(payload),
  }
}

export function createForwardMessage(payload: ForwardPayload, sourceId: string): TransportMessage {
  return {
    type: ReplicationMessageTypes.FORWARD,
    sourceId,
    requestId: generateId(),
    payload: encode(payload),
  }
}

export function createInsyncRemoveMessage(payload: InsyncRemovePayload, sourceId: string): TransportMessage {
  return {
    type: ReplicationMessageTypes.INSYNC_REMOVE,
    sourceId,
    requestId: generateId(),
    payload: encode(payload),
  }
}

export function createInsyncConfirmMessage(
  payload: InsyncConfirmPayload,
  sourceId: string,
  requestId: string,
): TransportMessage {
  return {
    type: ReplicationMessageTypes.INSYNC_CONFIRM,
    sourceId,
    requestId,
    payload: encode(payload),
  }
}

export function decodePayload<T>(payload: Uint8Array): T {
  return decode(payload) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validateEntryPayload(decoded: unknown): EntryPayload {
  if (!isRecord(decoded) || !isRecord(decoded.entry)) {
    throw new Error('Invalid EntryPayload: missing or invalid "entry" field')
  }
  const entry = decoded.entry
  if (typeof entry.seqNo !== 'number') {
    throw new Error('Invalid EntryPayload: "entry.seqNo" must be a number')
  }
  if (typeof entry.primaryTerm !== 'number') {
    throw new Error('Invalid EntryPayload: "entry.primaryTerm" must be a number')
  }
  if (entry.operation !== 'INDEX' && entry.operation !== 'DELETE') {
    throw new Error('Invalid EntryPayload: "entry.operation" must be "INDEX" or "DELETE"')
  }
  if (typeof entry.partitionId !== 'number') {
    throw new Error('Invalid EntryPayload: "entry.partitionId" must be a number')
  }
  if (typeof entry.indexName !== 'string') {
    throw new Error('Invalid EntryPayload: "entry.indexName" must be a string')
  }
  if (typeof entry.documentId !== 'string') {
    throw new Error('Invalid EntryPayload: "entry.documentId" must be a string')
  }
  if (entry.document !== null && !(entry.document instanceof Uint8Array)) {
    throw new Error('Invalid EntryPayload: "entry.document" must be Uint8Array or null')
  }
  if (typeof entry.checksum !== 'number') {
    throw new Error('Invalid EntryPayload: "entry.checksum" must be a number')
  }
  return decoded as unknown as EntryPayload
}

export function validateInsyncConfirmPayload(decoded: unknown): InsyncConfirmPayload {
  if (!isRecord(decoded)) {
    throw new Error('Invalid InsyncConfirmPayload: expected an object')
  }
  if (typeof decoded.indexName !== 'string') {
    throw new Error('Invalid InsyncConfirmPayload: "indexName" must be a string')
  }
  if (typeof decoded.partitionId !== 'number') {
    throw new Error('Invalid InsyncConfirmPayload: "partitionId" must be a number')
  }
  if (typeof decoded.accepted !== 'boolean') {
    throw new Error('Invalid InsyncConfirmPayload: "accepted" must be a boolean')
  }
  return decoded as unknown as InsyncConfirmPayload
}

export function validateAckPayload(decoded: unknown): AckPayload {
  if (!isRecord(decoded)) {
    throw new Error('Invalid AckPayload: expected an object')
  }
  if (typeof decoded.seqNo !== 'number') {
    throw new Error('Invalid AckPayload: "seqNo" must be a number')
  }
  if (typeof decoded.partitionId !== 'number') {
    throw new Error('Invalid AckPayload: "partitionId" must be a number')
  }
  if (typeof decoded.indexName !== 'string') {
    throw new Error('Invalid AckPayload: "indexName" must be a string')
  }
  return decoded as unknown as AckPayload
}
