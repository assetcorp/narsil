import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import type { AnyDocument } from '../../types/schema'
import type { FacetConfig, QueryParams } from '../../types/search'
import { validateFetchPayload, validateSearchPayload, validateStatsPayload } from '../query/codec'
import type {
  FetchResultPayload,
  ForwardPayload,
  SearchResultPayload,
  StatsResultPayload,
  TransportMessage,
} from '../transport/types'
import { QueryMessageTypes, ReplicationMessageTypes } from '../transport/types'

export type TransportHandler = (
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
) => void | Promise<void>

export interface DataNodeHandlerDeps {
  nodeId: string
  engine: Narsil
}

export function createDataNodeHandler(deps: DataNodeHandlerDeps): TransportHandler {
  return async (message: TransportMessage, respond: (response: TransportMessage) => void): Promise<void> => {
    try {
      switch (message.type) {
        case ReplicationMessageTypes.FORWARD:
          await handleForward(message, respond, deps)
          return
        case QueryMessageTypes.SEARCH:
          await handleSearch(message, respond, deps)
          return
        case QueryMessageTypes.FETCH:
          await handleFetch(message, respond, deps)
          return
        case QueryMessageTypes.STATS:
          await handleStats(message, respond, deps)
          return
        default:
          return
      }
    } catch (err) {
      const errorPayload = encode({
        error: true,
        code: err instanceof NarsilError ? err.code : 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
      })
      respond({
        type: `${message.type}.error`,
        sourceId: deps.nodeId,
        requestId: message.requestId,
        payload: errorPayload,
      })
    }
  }
}

async function handleForward(
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const decoded = decode(message.payload) as Record<string, unknown>
  const payload = validateForwardPayload(decoded)

  let documentId = payload.documentId
  if (payload.operation === 'insert') {
    if (payload.document === null) {
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: insert requires a document')
    }
    const document = decode(payload.document) as AnyDocument
    documentId = await deps.engine.insert(payload.indexName, document, payload.documentId)
  } else if (payload.operation === 'remove') {
    await deps.engine.remove(payload.indexName, payload.documentId)
  } else {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Forward update operations are not supported yet')
  }

  respond({
    type: ReplicationMessageTypes.FORWARD,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encode({ documentId, success: true }),
  })
}

async function handleSearch(
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
            similarity: payload.params.vector.k,
          }
        : undefined,
    hybrid:
      payload.params.hybrid !== null
        ? { strategy: payload.params.hybrid.strategy, k: payload.params.hybrid.k, alpha: payload.params.hybrid.alpha }
        : undefined,
  }

  const queryResult = await deps.engine.query(payload.indexName, queryParams)

  const scored = queryResult.hits.map(hit => ({
    docId: hit.id,
    score: hit.score,
    sortValues: null,
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

async function handleFetch(
  message: TransportMessage,
  respond: (response: TransportMessage) => void,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const decoded = decode(message.payload) as unknown
  const payload = validateFetchPayload(decoded)

  const documents = []
  for (const docRef of payload.documentIds) {
    const doc = await deps.engine.get(payload.indexName, docRef.docId)
    if (doc !== undefined) {
      documents.push({
        docId: docRef.docId,
        document: doc as Record<string, unknown>,
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

async function handleStats(
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

export function validateForwardPayload(decoded: unknown): ForwardPayload {
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: expected an object')
  }
  const record = decoded as Record<string, unknown>
  if (typeof record.indexName !== 'string' || record.indexName.length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: "indexName" must be a non-empty string')
  }
  if (typeof record.documentId !== 'string' || record.documentId.length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'Invalid ForwardPayload: "documentId" must be a non-empty string')
  }
  if (record.operation !== 'insert' && record.operation !== 'remove' && record.operation !== 'update') {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Invalid ForwardPayload: "operation" must be "insert", "remove", or "update"',
    )
  }
  return decoded as unknown as ForwardPayload
}

function convertWireSortToLocal(
  wireSort: Array<{ field: string; direction: 'asc' | 'desc' }> | null,
): Record<string, 'asc' | 'desc'> | undefined {
  if (wireSort === null || wireSort.length === 0) {
    return undefined
  }
  const result: Record<string, 'asc' | 'desc'> = {}
  for (const entry of wireSort) {
    result[entry.field] = entry.direction
  }
  return result
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
  facets: Awaited<ReturnType<Narsil['query']>>['facets'],
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
