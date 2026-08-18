import { decode, encode } from '@msgpack/msgpack'
import { applyProjection, resolveProjection } from '../../../core/projection'
import { normalizeSort, readSortValues } from '../../../search/sorting'
import type { QueryResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import { validateFetchPayload, validateSearchPayload, validateStatsPayload } from '../../query/codec'
import type {
  FetchResultPayload,
  SearchResultPayload,
  StatsResultPayload,
  TransportMessage,
} from '../../transport/types'
import { QueryMessageTypes } from '../../transport/types'
import { wireParamsToLocal } from '../query-conversion'
import type { DataNodeHandlerDeps } from './types'

export async function handleSearch(
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const decoded = decode(message.payload) as unknown
  const payload = validateSearchPayload(decoded)

  const queryParams = wireParamsToLocal(payload.params, payload.facetShardSize)
  const queryResult = await deps.engine.queryPartitions(
    payload.indexName,
    queryParams,
    payload.partitionIds,
    payload.globalStats ?? undefined,
  )

  const sortFields = queryParams.sort !== undefined ? normalizeSort(queryParams.sort).map(entry => entry.field) : null
  const scored = queryResult.hits.map(hit => ({
    docId: hit.id,
    score: hit.score ?? null,
    sortValues:
      sortFields !== null
        ? readSortValues(hit.document as AnyDocument | undefined, sortFields).map(toWireSortValue)
        : null,
  }))

  const results = payload.partitionIds.map(partitionId => ({
    partitionId,
    scored: partitionId === payload.partitionIds[0] ? scored : [],
    totalHits: partitionId === payload.partitionIds[0] ? queryResult.count : 0,
  }))

  const resultPayload: SearchResultPayload = { results, facets: convertLocalFacetsToWire(queryResult.facets) }

  respond({
    type: QueryMessageTypes.SEARCH_RESULT,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode(resultPayload),
  })
}

export async function handleFetch(
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const decoded = decode(message.payload) as unknown
  const payload = validateFetchPayload(decoded)

  const projection = resolveProjection(payload.fields === null ? undefined : { include: payload.fields })

  const documents = []
  for (const docRef of payload.documentIds) {
    const doc = await deps.engine.get(payload.indexName, docRef.docId)
    if (doc !== undefined) {
      documents.push({
        docId: docRef.docId,
        document: applyProjection(doc as AnyDocument, projection) as Record<string, unknown>,
        highlights: null,
      })
    }
  }

  const resultPayload: FetchResultPayload = { documents }

  respond({
    type: QueryMessageTypes.FETCH_RESULT,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode(resultPayload),
  })
}

export async function handleStats(
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const decoded = decode(message.payload) as unknown
  const payload = validateStatsPayload(decoded)

  const resultPayload: StatsResultPayload = deps.engine.collectQueryStats(
    payload.indexName,
    payload.terms,
    payload.partitionIds,
  )

  respond({
    type: QueryMessageTypes.STATS_RESULT,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode(resultPayload),
  })
}

function toWireSortValue(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  return null
}

export function convertLocalFacetsToWire(
  facets: QueryResult['facets'],
): Record<string, Array<{ value: string; count: number }>> | null {
  if (facets === undefined) {
    return null
  }
  const result: Record<string, Array<{ value: string; count: number }>> = {}
  for (const [field, facet] of Object.entries(facets)) {
    result[field] = Object.entries(facet.values).map(([value, count]) => ({ value, count }))
  }
  return result
}
