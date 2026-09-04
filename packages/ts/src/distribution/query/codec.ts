import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import type {
  CountPayload,
  CountResultPayload,
  FetchPayload,
  FetchResultPayload,
  ListPayload,
  ListResultPayload,
  PreflightPayload,
  PreflightResultPayload,
  SearchPayload,
  SearchResultPayload,
  StatsPayload,
  StatsResultPayload,
  SuggestPayload,
  SuggestResultPayload,
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

export function createCountMessage(payload: CountPayload, sourceId: string): TransportMessage {
  return {
    type: QueryMessageTypes.COUNT,
    sourceId,
    requestId: generateId(),
    payload: encode(payload),
  }
}

export function createCountResultMessage(
  payload: CountResultPayload,
  sourceId: string,
  requestId: string,
): TransportMessage {
  return {
    type: QueryMessageTypes.COUNT_RESULT,
    sourceId,
    requestId,
    payload: encode(payload),
  }
}

export function createListMessage(payload: ListPayload, sourceId: string): TransportMessage {
  return {
    type: QueryMessageTypes.LIST,
    sourceId,
    requestId: generateId(),
    payload: encode(payload),
  }
}

export function createListResultMessage(
  payload: ListResultPayload,
  sourceId: string,
  requestId: string,
): TransportMessage {
  return {
    type: QueryMessageTypes.LIST_RESULT,
    sourceId,
    requestId,
    payload: encode(payload),
  }
}

export function createSuggestMessage(payload: SuggestPayload, sourceId: string): TransportMessage {
  return {
    type: QueryMessageTypes.SUGGEST,
    sourceId,
    requestId: generateId(),
    payload: encode(payload),
  }
}

export function createSuggestResultMessage(
  payload: SuggestResultPayload,
  sourceId: string,
  requestId: string,
): TransportMessage {
  return {
    type: QueryMessageTypes.SUGGEST_RESULT,
    sourceId,
    requestId,
    payload: encode(payload),
  }
}

export function createPreflightMessage(payload: PreflightPayload, sourceId: string): TransportMessage {
  return {
    type: QueryMessageTypes.PREFLIGHT,
    sourceId,
    requestId: generateId(),
    payload: encode(payload),
  }
}

export function createPreflightResultMessage(
  payload: PreflightResultPayload,
  sourceId: string,
  requestId: string,
): TransportMessage {
  return {
    type: QueryMessageTypes.PREFLIGHT_RESULT,
    sourceId,
    requestId,
    payload: encode(payload),
  }
}

export function decodePayload<T>(payload: Uint8Array): T {
  return decode(payload) as T
}

export {
  MAX_LIST_CURSOR_LENGTH,
  MAX_SUGGEST_WIRE_LIMIT,
  MAX_VECTOR_DIMENSION,
  MAX_VECTOR_TEXT_LENGTH,
} from './constants'
export { validateFetchPayload, validateFetchResultPayload } from './validators/fetch'
export {
  validateCountPayload,
  validateCountResultPayload,
  validateListPayload,
  validateListResultPayload,
  validatePreflightPayload,
  validatePreflightResultPayload,
  validateSuggestPayload,
  validateSuggestResultPayload,
} from './validators/reads'
export { MAX_FACET_SHARD_SIZE, validateSearchPayload } from './validators/search'
export { validateSearchResultPayload } from './validators/search-result'
export { validateGlobalStatistics, validateStatsPayload, validateStatsResultPayload } from './validators/stats'
