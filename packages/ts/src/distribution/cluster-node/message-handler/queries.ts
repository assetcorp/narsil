import { decode, encode } from '@msgpack/msgpack'
import type { SortMode } from '../../../core/ordering'
import { applyProjection, type ResolvedProjection, resolveProjection } from '../../../core/projection'
import { ErrorCodes, NarsilError } from '../../../errors'
import { oversampledShardSize } from '../../../search/oversample'
import { normalizeSort, readSortValues, sortModesOf } from '../../../search/sorting'
import { encodeDocumentReply } from '../../../serialization/document-encoding'
import type { QueryResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import { validateFetchPayload, validateSearchPayload, validateStatsPayload } from '../../query/codec'
import type {
  FetchDocumentId,
  FetchedDocument,
  FetchResultPayload,
  RespondFn,
  SearchResultPayload,
  StatsResultPayload,
  TransportMessage,
  WireGroupEntry,
} from '../../transport/types'
import { QueryMessageTypes } from '../../transport/types'
import { answerRefusalOf, refuseEncodeWithoutRoom } from '../memory/answer-room'
import { wireParamsToLocal } from '../query-conversion'
import { documentOfSnapshot, heldBytesOf, keepAliveOf } from '../search-contexts'
import type { DocumentSnapshot } from '../search-contexts/snapshots'
import type { DataNodeHandlerDeps } from './types'

export async function handleSearch(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const decoded = decode(message.payload) as unknown
  const payload = validateSearchPayload(decoded)

  const queryParams = wireParamsToLocal(payload.params, payload.facetShardSize)
  if (queryParams.group?.limit !== undefined) {
    queryParams.group = { ...queryParams.group, limit: oversampledShardSize(queryParams.group.limit) }
  }
  const rescoreWindow = payload.params.vector?.rescoreWindow ?? undefined
  const keepAliveMs = payload.keepAliveMs ?? null
  const snapshots =
    keepAliveMs === null || deps.searchContexts === undefined ? undefined : new Map<string, DocumentSnapshot>()
  if (
    snapshots !== undefined ||
    (rescoreWindow !== undefined && queryParams.sort === undefined && queryParams.group === undefined)
  ) {
    queryParams.document = false
  }
  const queryResult = await deps.analysisView.answerAt(payload.indexName, payload.params.analysisGeneration ?? 0, () =>
    deps.engine.queryPartitions(
      payload.indexName,
      queryParams,
      payload.partitionIds,
      payload.globalStats ?? undefined,
      rescoreWindow,
      snapshots,
      payload.params.indexBm25 ?? undefined,
    ),
  )
  const rankedDocument = (hit: { id: string; document?: unknown }): AnyDocument | undefined =>
    (snapshots?.get(hit.id)?.fields as AnyDocument | undefined) ?? (hit.document as AnyDocument | undefined)

  const normalizedSort = queryParams.sort !== undefined ? normalizeSort(queryParams.sort) : null
  const sortFields = normalizedSort === null ? null : normalizedSort.map(entry => entry.field)
  const sortModes = normalizedSort === null ? [] : sortModesOf(normalizedSort)
  const scored = queryResult.hits.map(hit => ({
    docId: hit.id,
    score: hit.score ?? null,
    sortValues:
      sortFields !== null ? readSortValues(rankedDocument(hit), sortFields, sortModes).map(toWireSortValue) : null,
  }))

  const results = payload.partitionIds.map(partitionId => ({
    partitionId,
    scored: partitionId === payload.partitionIds[0] ? scored : [],
    totalHits: partitionId === payload.partitionIds[0] ? queryResult.count : 0,
  }))

  const resultPayload: SearchResultPayload = {
    results,
    facets: convertLocalFacetsToWire(queryResult.facets),
    facetErrorBounds: convertLocalFacetBoundsToWire(queryResult.facets),
    groups: await convertLocalGroupsToWire(
      queryResult.groups,
      sortFields,
      sortModes,
      deps,
      payload.indexName,
      snapshots,
    ),
  }
  if (snapshots !== undefined && keepAliveMs !== null) {
    resultPayload.contextId = openSearchContext(deps, message.sourceId, keepAliveMs, snapshots)
  }

  await respond({
    type: QueryMessageTypes.SEARCH_RESULT,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encodeDocumentReply(resultPayload),
  })
}

async function convertLocalGroupsToWire(
  groups: QueryResult['groups'],
  sortFields: string[] | null,
  sortModes: readonly SortMode[],
  deps: DataNodeHandlerDeps,
  indexName: string,
  snapshots: ReadonlyMap<string, DocumentSnapshot> | undefined,
): Promise<WireGroupEntry[] | null> {
  if (groups === undefined) {
    return null
  }
  const unreadIds =
    sortFields === null || snapshots !== undefined
      ? []
      : groups.flatMap(group => group.hits.filter(hit => hit.document === undefined).map(hit => hit.id))
  const readDocuments =
    unreadIds.length > 0 ? await deps.engine.getMultiple(indexName, unreadIds) : new Map<string, AnyDocument>()
  const wireGroups: WireGroupEntry[] = []
  for (const group of groups) {
    const scored = group.hits.map(hit => {
      if (sortFields === null) return { docId: hit.id, score: hit.score ?? null, sortValues: null }
      const document =
        (snapshots?.get(hit.id)?.fields as AnyDocument | undefined) ??
        (hit.document as AnyDocument | undefined) ??
        readDocuments.get(hit.id)
      const sortValues = readSortValues(document, sortFields, sortModes).map(toWireSortValue)
      return { docId: hit.id, score: hit.score ?? null, sortValues }
    })
    wireGroups.push({ values: group.values, scored })
  }
  return wireGroups
}

export async function handleFetch(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const decoded = decode(message.payload) as unknown
  const payload = validateFetchPayload(decoded)

  const projection = resolveProjection(payload.fields === null ? undefined : { include: payload.fields })

  const contextId = payload.contextId ?? null
  const documents =
    contextId === null
      ? await readCurrentDocuments(deps, payload.indexName, payload.documentIds, projection)
      : readContextDocuments(deps, contextId, payload.documentIds, payload.releaseContext !== false, projection)

  refuseEncodeWithoutRoom(documents.map(fetched => fetched.document))
  const resultPayload: FetchResultPayload = { documents }

  await respond({
    type: QueryMessageTypes.FETCH_RESULT,
    sourceId: deps.nodeId,
    requestId: message.requestId,
    payload: encodeDocumentReply(resultPayload),
  })
}

async function readCurrentDocuments(
  deps: DataNodeHandlerDeps,
  indexName: string,
  documentIds: readonly FetchDocumentId[],
  projection: ResolvedProjection,
): Promise<FetchedDocument[]> {
  const documents: FetchedDocument[] = []
  for (const docRef of documentIds) {
    const doc = await deps.engine.get(indexName, docRef.docId)
    if (doc !== undefined) {
      documents.push({
        docId: docRef.docId,
        document: applyProjection(doc as AnyDocument, projection) as Record<string, unknown>,
        highlights: null,
      })
    }
  }
  return documents
}

function readContextDocuments(
  deps: DataNodeHandlerDeps,
  contextId: string,
  documentIds: readonly FetchDocumentId[],
  releaseContext: boolean,
  projection: ResolvedProjection,
): FetchedDocument[] {
  const docIds = documentIds.map(docRef => docRef.docId)
  const found = deps.searchContexts?.read(contextId, docIds) ?? null
  if (releaseContext) deps.searchContexts?.release(contextId)
  if (found === null) {
    if (docIds.length === 0) return []
    throw new NarsilError(
      ErrorCodes.SEARCH_CONTEXT_MISSING,
      `Node '${deps.nodeId}' holds no search context '${contextId}', because it expired, the node restarted, or the coordinating node released it`,
      { contextId, nodeId: deps.nodeId },
    )
  }
  const documents: FetchedDocument[] = []
  for (const docId of docIds) {
    const snapshot = found.get(docId)
    if (snapshot === undefined) continue
    documents.push({
      docId,
      document: applyProjection(documentOfSnapshot(snapshot), projection) as Record<string, unknown>,
      highlights: null,
    })
  }
  return documents
}

function openSearchContext(
  deps: DataNodeHandlerDeps,
  coordinatorNodeId: string,
  keepAliveMs: number,
  snapshots: ReadonlyMap<string, DocumentSnapshot>,
): string | null {
  if (deps.searchContexts === undefined || snapshots.size === 0) return null
  const refusal = answerRefusalOf(heldBytesOf(snapshots))
  if (refusal !== null) throw refusal
  return deps.searchContexts.open(coordinatorNodeId, keepAliveOf(keepAliveMs), snapshots)
}

export async function handleStats(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const decoded = decode(message.payload) as unknown
  const payload = validateStatsPayload(decoded)

  const resultPayload: StatsResultPayload = await deps.analysisView.answerAt(
    payload.indexName,
    payload.analysisGeneration ?? 0,
    () =>
      deps.engine.collectQueryStats(payload.indexName, payload.terms, payload.partitionIds, {
        expansion: payload.expansion ?? undefined,
        tokens: payload.tokens ?? undefined,
      }),
  )

  await respond({
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

/**
 * Reads the largest count each field left out into the shape the wire carries.
 *
 * @param facets - What this node counted, or undefined where the query asked for none.
 * @returns One figure per field, or null where the node counted nothing.
 */
export function convertLocalFacetBoundsToWire(facets: QueryResult['facets']): Record<string, number> | null {
  if (facets === undefined) {
    return null
  }
  const result: Record<string, number> = {}
  for (const [field, facet] of Object.entries(facets)) {
    result[field] = facet.errorBound
  }
  return result
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
