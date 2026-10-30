import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import type { TransportMessage } from '../transport/types'
import { ReplicationMessageTypes } from '../transport/types'
import { optionalIndexUuid } from './codec'

export interface TermStartPayload {
  indexName: string
  partitionId: number
  primaryTerm: number
  lastSeqNo: number
  lastPrimaryTerm: number
  indexUuid?: string
}

export interface TermStartAckPayload {
  indexName: string
  partitionId: number
  lastSeqNo: number
  lastPrimaryTerm: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireCount(record: Record<string, unknown>, field: string, payloadName: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${payloadName}: "${field}" must be a non-negative integer`)
  }
  return value
}

function requireIndexName(record: Record<string, unknown>, payloadName: string): string {
  if (typeof record.indexName !== 'string' || record.indexName.length === 0) {
    throw new Error(`Invalid ${payloadName}: "indexName" must be a non-empty string`)
  }
  return record.indexName
}

export function createTermStartMessage(payload: TermStartPayload, sourceId: string): TransportMessage {
  return {
    type: ReplicationMessageTypes.TERM_START,
    sourceId,
    requestId: generateId(),
    payload: encode(payload),
  }
}

export function createTermStartAckMessage(
  payload: TermStartAckPayload,
  sourceId: string,
  requestId: string,
): TransportMessage {
  return {
    type: ReplicationMessageTypes.TERM_START_ACK,
    sourceId,
    requestId,
    payload: encode(payload),
  }
}

export function validateTermStartPayload(payload: Uint8Array): TermStartPayload {
  const decoded = decode(payload)
  if (!isRecord(decoded)) {
    throw new Error('Invalid TermStartPayload: expected an object')
  }
  const validated: TermStartPayload = {
    indexName: requireIndexName(decoded, 'TermStartPayload'),
    partitionId: requireCount(decoded, 'partitionId', 'TermStartPayload'),
    primaryTerm: requireCount(decoded, 'primaryTerm', 'TermStartPayload'),
    lastSeqNo: requireCount(decoded, 'lastSeqNo', 'TermStartPayload'),
    lastPrimaryTerm: requireCount(decoded, 'lastPrimaryTerm', 'TermStartPayload'),
  }
  const indexUuid = optionalIndexUuid(decoded.indexUuid, 'TermStartPayload')
  if (indexUuid !== undefined) validated.indexUuid = indexUuid
  return validated
}

export function termStartAckOf(response: TransportMessage, request: TermStartPayload): TermStartAckPayload | null {
  if (response.type !== ReplicationMessageTypes.TERM_START_ACK) return null
  try {
    const decoded = decode(response.payload)
    if (!isRecord(decoded)) return null
    const answer: TermStartAckPayload = {
      indexName: requireIndexName(decoded, 'TermStartAckPayload'),
      partitionId: requireCount(decoded, 'partitionId', 'TermStartAckPayload'),
      lastSeqNo: requireCount(decoded, 'lastSeqNo', 'TermStartAckPayload'),
      lastPrimaryTerm: requireCount(decoded, 'lastPrimaryTerm', 'TermStartAckPayload'),
    }
    return answer.indexName === request.indexName && answer.partitionId === request.partitionId ? answer : null
  } catch {
    return null
  }
}
