import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import type {
  FetchPayload,
  FetchResultPayload,
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

export function decodePayload<T>(payload: Uint8Array): T {
  return decode(payload) as T
}

export { validateFetchPayload, validateFetchResultPayload } from './validators/fetch'
export {
  MAX_FACET_SHARD_SIZE,
  MAX_VECTOR_DIMENSION,
  MAX_VECTOR_TEXT_LENGTH,
  validateSearchPayload,
} from './validators/search'
export { validateSearchResultPayload } from './validators/search-result'
export { validateGlobalStatistics, validateStatsPayload, validateStatsResultPayload } from './validators/stats'
