import { decode, encode } from '@msgpack/msgpack'
import { applyProjection, resolveProjection } from '../../../core/projection'
import { normalizeSort, readSortValues } from '../../../search/sorting'
import type { QueryResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import type { FacetConfig, QueryParams } from '../../../types/search'
import { validateFetchPayload, validateSearchPayload, validateStatsPayload } from '../../query/codec'
import type {
  FetchResultPayload,
  SearchResultPayload,
  SortField,
  StatsResultPayload,
  TransportMessage,
} from '../../transport/types'
import { QueryMessageTypes } from '../../transport/types'
import type { DataNodeHandlerDeps } from './types'

export async function handleSearch(
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const decoded = decode(message.payload) as unknown
  const payload = validateSearchPayload(decoded)

  const queryParams: QueryParams = {
    term: payload.params.term ?? undefined,
    fields: payload.params.fields ?? undefined,
    filters: payload.params.filters ?? undefined,
    boost: payload.params.boost ?? undefined,
    scoring: payload.params.scoring,
    tolerance: payload.params.tolerance ?? undefined,
    minScore: payload.params.threshold ?? undefined,
    includeScores: payload.params.includeScores ?? undefined,
    limit: payload.params.limit,
    offset: payload.params.offset,
    searchAfter: payload.params.searchAfter ?? undefined,
    sort: convertWireSortToLocal(payload.params.sort),
    group:
      payload.params.group !== null
        ? { fields: [payload.params.group.field], maxPerGroup: payload.params.group.maxPerGroup }
        : undefined,
    facets: convertWireFacetsToLocal(payload.params.facets, payload.facetShardSize ?? payload.params.facetSize),
    vector:
      payload.params.vector !== null
        ? {
            field: payload.params.vector.field,
            value: payload.params.vector.value ?? undefined,
            text: payload.params.vector.text ?? undefined,
            similarity: payload.params.vector.similarity ?? undefined,
          }
        : undefined,
    hybrid:
      payload.params.hybrid !== null
        ? { strategy: payload.params.hybrid.strategy, k: payload.params.hybrid.k, alpha: payload.params.hybrid.alpha }
        : undefined,
  }

  const queryResult = await deps.engine.query(payload.indexName, queryParams)

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

  const stats = deps.engine.getStats(payload.indexName)
  const resultPayload: StatsResultPayload = {
    totalDocuments: stats.documentCount,
    docFrequencies: {},
    totalFieldLengths: {},
  }

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

function convertWireSortToLocal(wireSort: SortField[] | null): SortField[] | undefined {
  if (wireSort === null || wireSort.length === 0) {
    return undefined
  }
  return wireSort.map(entry => ({ field: entry.field, direction: entry.direction }))
}

function convertWireFacetsToLocal(facets: string[] | null, limit: number | null): FacetConfig | undefined {
  if (facets === null || facets.length === 0) {
    return undefined
  }
  const result: FacetConfig = {}
  for (const field of facets) {
    result[field] = limit !== null ? { limit } : {}
  }
  return result
}

function convertLocalFacetsToWire(
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
