import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import { WIRE_BATCH_BUDGET } from '../constants'
import type {
  AckPayload,
  EntryBatchPayload,
  EntryPayload,
  ForwardBatchPayload,
  ForwardBatchResultPayload,
  ForwardPayload,
  InsyncAddPayload,
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

export function createEntryBatchMessage(entries: ReplicationLogEntry[], sourceId: string): TransportMessage {
  const payload: EntryBatchPayload = { entries }
  return {
    type: ReplicationMessageTypes.ENTRY_BATCH,
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

export const MAX_FORWARD_BATCH_OPERATIONS = WIRE_BATCH_BUDGET.maxCount

export function createForwardBatchMessage(payload: ForwardBatchPayload, sourceId: string): TransportMessage {
  return {
    type: ReplicationMessageTypes.FORWARD_BATCH,
    sourceId,
    requestId: generateId(),
    payload: encode(payload),
  }
}

export function createForwardBatchResultMessage(
  payload: ForwardBatchResultPayload,
  sourceId: string,
  requestId: string,
): TransportMessage {
  return {
    type: ReplicationMessageTypes.FORWARD_BATCH,
    sourceId,
    requestId,
    payload: encode(payload),
  }
}

/**
 * Wraps an in-sync admission request in the transport message the primary sends to the controller.
 *
 * @param payload - The request, which names the replica and states both its applied position and the primary's
 *   commit point.
 * @param sourceId - The primary's own node id, which the controller compares with the assignment's primary.
 * @returns The message, which holds a fresh request id that the confirmation repeats.
 */
export function createInsyncAddMessage(payload: InsyncAddPayload, sourceId: string): TransportMessage {
  return {
    type: ReplicationMessageTypes.INSYNC_ADD,
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

export function validateEntryBatchPayload(decoded: unknown): EntryBatchPayload {
  if (!isRecord(decoded) || !Array.isArray(decoded.entries)) {
    throw new Error('Invalid EntryBatchPayload: missing or invalid "entries" field')
  }
  if (decoded.entries.length === 0) {
    throw new Error('Invalid EntryBatchPayload: "entries" must not be empty')
  }

  const validated = decoded.entries.map(candidate => validateEntryPayload({ entry: candidate }).entry)
  const first = validated[0]

  for (let index = 1; index < validated.length; index++) {
    const entry = validated[index]
    if (entry.indexName !== first.indexName || entry.partitionId !== first.partitionId) {
      throw new Error('Invalid EntryBatchPayload: entries must belong to one partition of one index')
    }
    if (entry.primaryTerm !== first.primaryTerm) {
      throw new Error('Invalid EntryBatchPayload: entries must share one primary term')
    }
    if (entry.seqNo !== validated[index - 1].seqNo + 1) {
      throw new Error('Invalid EntryBatchPayload: entries must carry contiguous ascending sequence numbers')
    }
  }

  return { entries: validated }
}

export function validateForwardBatchPayload(decoded: unknown): ForwardBatchPayload {
  if (!isRecord(decoded)) {
    throw new Error('Invalid ForwardBatchPayload: expected an object')
  }
  if (typeof decoded.indexName !== 'string' || decoded.indexName.length === 0) {
    throw new Error('Invalid ForwardBatchPayload: "indexName" must be a non-empty string')
  }
  if (!Array.isArray(decoded.operations)) {
    throw new Error('Invalid ForwardBatchPayload: "operations" must be an array')
  }
  if (decoded.operations.length === 0) {
    throw new Error('Invalid ForwardBatchPayload: "operations" must not be empty')
  }
  if (decoded.operations.length > MAX_FORWARD_BATCH_OPERATIONS) {
    throw new Error(
      `Invalid ForwardBatchPayload: "operations" exceeds maximum length of ${MAX_FORWARD_BATCH_OPERATIONS}`,
    )
  }
  for (let index = 0; index < decoded.operations.length; index++) {
    const operation = decoded.operations[index]
    if (!isRecord(operation)) {
      throw new Error(`Invalid ForwardBatchPayload: "operations[${index}]" must be an object`)
    }
    if (typeof operation.documentId !== 'string' || operation.documentId.length === 0) {
      throw new Error(`Invalid ForwardBatchPayload: "operations[${index}].documentId" must be a non-empty string`)
    }
    if (operation.operation !== 'insert' && operation.operation !== 'remove' && operation.operation !== 'update') {
      throw new Error(
        `Invalid ForwardBatchPayload: "operations[${index}].operation" must be "insert", "remove", or "update"`,
      )
    }
    if (operation.document !== null && !(operation.document instanceof Uint8Array)) {
      throw new Error(`Invalid ForwardBatchPayload: "operations[${index}].document" must be Uint8Array or null`)
    }
    if (operation.operation === 'insert' && operation.document === null) {
      throw new Error(`Invalid ForwardBatchPayload: "operations[${index}]" requires a document`)
    }
    if (operation.operation === 'update' && operation.document === null && !isRecord(operation.updateFields)) {
      throw new Error(`Invalid ForwardBatchPayload: "operations[${index}]" requires a document or updateFields`)
    }
  }
  return decoded as unknown as ForwardBatchPayload
}

export function validateForwardBatchResultPayload(decoded: unknown): ForwardBatchResultPayload {
  if (!isRecord(decoded)) {
    throw new Error('Invalid ForwardBatchResultPayload: expected an object')
  }
  if (!Array.isArray(decoded.results)) {
    throw new Error('Invalid ForwardBatchResultPayload: "results" must be an array')
  }
  for (let index = 0; index < decoded.results.length; index++) {
    const result = decoded.results[index]
    if (!isRecord(result)) {
      throw new Error(`Invalid ForwardBatchResultPayload: "results[${index}]" must be an object`)
    }
    if (typeof result.documentId !== 'string') {
      throw new Error(`Invalid ForwardBatchResultPayload: "results[${index}].documentId" must be a string`)
    }
    if (typeof result.success !== 'boolean') {
      throw new Error(`Invalid ForwardBatchResultPayload: "results[${index}].success" must be a boolean`)
    }
    if (result.errorCode !== null && typeof result.errorCode !== 'string') {
      throw new Error(`Invalid ForwardBatchResultPayload: "results[${index}].errorCode" must be a string or null`)
    }
    if (result.errorMessage !== null && typeof result.errorMessage !== 'string') {
      throw new Error(`Invalid ForwardBatchResultPayload: "results[${index}].errorMessage" must be a string or null`)
    }
  }
  return decoded as unknown as ForwardBatchResultPayload
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
