import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import type {
  FetchPayload,
  FetchResultPayload,
  GlobalStatistics,
  SearchPayload,
  SearchResultPayload,
  StatsPayload,
  StatsResultPayload,
  TransportMessage,
} from '../transport/types'
import { QueryMessageTypes } from '../transport/types'

export function createSearchMessage(payload: SearchPayload, sourceId: string): TransportMessage {
  return {
    type: QueryMessageTypes.SEARCH,
    sourceId,
    requestId: generateId(),
    payload: encode(payload),
  }
}

export function createSearchResultMessage(
  payload: SearchResultPayload,
  sourceId: string,
  requestId: string,
): TransportMessage {
  return {
    type: QueryMessageTypes.SEARCH_RESULT,
    sourceId,
    requestId,
    payload: encode(payload),
  }
}

export function createFetchMessage(payload: FetchPayload, sourceId: string): TransportMessage {
  return {
    type: QueryMessageTypes.FETCH,
    sourceId,
    requestId: generateId(),
    payload: encode(payload),
  }
}

export function createFetchResultMessage(
  payload: FetchResultPayload,
  sourceId: string,
  requestId: string,
): TransportMessage {
  return {
    type: QueryMessageTypes.FETCH_RESULT,
    sourceId,
    requestId,
    payload: encode(payload),
  }
}

export function createStatsMessage(payload: StatsPayload, sourceId: string): TransportMessage {
  return {
    type: QueryMessageTypes.STATS,
    sourceId,
    requestId: generateId(),
    payload: encode(payload),
  }
}

export function createStatsResultMessage(
  payload: StatsResultPayload,
  sourceId: string,
  requestId: string,
): TransportMessage {
  return {
    type: QueryMessageTypes.STATS_RESULT,
    sourceId,
    requestId,
    payload: encode(payload),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isScoredEntry(value: unknown): value is { docId: string; score: number; sortValues: unknown[] | null } {
  if (!isRecord(value)) return false
  return typeof value.docId === 'string' && typeof value.score === 'number'
}

function isPartitionSearchResult(
  value: unknown,
): value is { partitionId: number; scored: Array<{ docId: string; score: number }>; totalHits: number } {
  if (!isRecord(value)) return false
  return typeof value.partitionId === 'number' && typeof value.totalHits === 'number' && Array.isArray(value.scored)
}

export function validateSearchPayload(decoded: unknown): SearchPayload {
  if (!isRecord(decoded)) {
    throw new Error('Invalid SearchPayload: expected an object')
  }
  if (typeof decoded.indexName !== 'string') {
    throw new Error('Invalid SearchPayload: "indexName" must be a string')
  }
  if (!Array.isArray(decoded.partitionIds)) {
    throw new Error('Invalid SearchPayload: "partitionIds" must be an array')
  }
  for (const id of decoded.partitionIds) {
    if (typeof id !== 'number') {
      throw new Error('Invalid SearchPayload: each partitionId must be a number')
    }
  }
  if (!isRecord(decoded.params)) {
    throw new Error('Invalid SearchPayload: "params" must be an object')
  }
  return decoded as unknown as SearchPayload
}

export function validateSearchResultPayload(decoded: unknown): SearchResultPayload {
  if (!isRecord(decoded)) {
    throw new Error('Invalid SearchResultPayload: expected an object')
  }
  if (!Array.isArray(decoded.results)) {
    throw new Error('Invalid SearchResultPayload: "results" must be an array')
  }
  for (const result of decoded.results) {
    if (!isPartitionSearchResult(result)) {
      throw new Error('Invalid SearchResultPayload: each result must have partitionId, scored, and totalHits')
    }
    for (const entry of (result as { scored: unknown[] }).scored) {
      if (!isScoredEntry(entry)) {
        throw new Error('Invalid SearchResultPayload: each scored entry must have docId and score')
      }
    }
  }
  return decoded as unknown as SearchResultPayload
}

export function validateStatsPayload(decoded: unknown): StatsPayload {
  if (!isRecord(decoded)) {
    throw new Error('Invalid StatsPayload: expected an object')
  }
  if (typeof decoded.indexName !== 'string') {
    throw new Error('Invalid StatsPayload: "indexName" must be a string')
  }
  if (!Array.isArray(decoded.partitionIds)) {
    throw new Error('Invalid StatsPayload: "partitionIds" must be an array')
  }
  if (!Array.isArray(decoded.terms)) {
    throw new Error('Invalid StatsPayload: "terms" must be an array')
  }
  return decoded as unknown as StatsPayload
}

export function validateStatsResultPayload(decoded: unknown): StatsResultPayload {
  if (!isRecord(decoded)) {
    throw new Error('Invalid StatsResultPayload: expected an object')
  }
  if (typeof decoded.totalDocuments !== 'number') {
    throw new Error('Invalid StatsResultPayload: "totalDocuments" must be a number')
  }
  if (!isRecord(decoded.docFrequencies)) {
    throw new Error('Invalid StatsResultPayload: "docFrequencies" must be an object')
  }
  if (!isRecord(decoded.totalFieldLengths)) {
    throw new Error('Invalid StatsResultPayload: "totalFieldLengths" must be an object')
  }
  return decoded as unknown as StatsResultPayload
}

export function validateFetchPayload(decoded: unknown): FetchPayload {
  if (!isRecord(decoded)) {
    throw new Error('Invalid FetchPayload: expected an object')
  }
  if (typeof decoded.indexName !== 'string') {
    throw new Error('Invalid FetchPayload: "indexName" must be a string')
  }
  if (!Array.isArray(decoded.documentIds)) {
    throw new Error('Invalid FetchPayload: "documentIds" must be an array')
  }
  return decoded as unknown as FetchPayload
}

export function validateFetchResultPayload(decoded: unknown): FetchResultPayload {
  if (!isRecord(decoded)) {
    throw new Error('Invalid FetchResultPayload: expected an object')
  }
  if (!Array.isArray(decoded.documents)) {
    throw new Error('Invalid FetchResultPayload: "documents" must be an array')
  }
  return decoded as unknown as FetchResultPayload
}

export function decodePayload<T>(payload: Uint8Array): T {
  return decode(payload) as T
}

export function validateGlobalStatistics(decoded: unknown): GlobalStatistics {
  if (!isRecord(decoded)) {
    throw new Error('Invalid GlobalStatistics: expected an object')
  }
  if (typeof decoded.totalDocuments !== 'number') {
    throw new Error('Invalid GlobalStatistics: "totalDocuments" must be a number')
  }
  if (!isRecord(decoded.docFrequencies)) {
    throw new Error('Invalid GlobalStatistics: "docFrequencies" must be an object')
  }
  if (!isRecord(decoded.totalFieldLengths)) {
    throw new Error('Invalid GlobalStatistics: "totalFieldLengths" must be an object')
  }
  if (!isRecord(decoded.averageFieldLengths)) {
    throw new Error('Invalid GlobalStatistics: "averageFieldLengths" must be an object')
  }
  return decoded as unknown as GlobalStatistics
}
