import { type ComparableSortValue, compareCodePoints, toComparableSortValue } from '../../../core/ordering'
import { applyProjection, type ResolvedProjection, resolveProjection } from '../../../core/projection'
import { requireLoadedOptionalReads } from '../../../engine/optional-reads-code'
import { clampLimit, now } from '../../../engine/validation'
import { decodePageCursor, encodePageCursor, requireMatchingCursor, sortSignatureOf } from '../../../search/cursor'
import { listBindingOf } from '../../../search/cursor-binding'
import { requireWithinResultWindow } from '../../../search/pagination'
import { normalizeSort } from '../../../search/sorting'
import type { ListedDocument, ListResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import type { ListParams } from '../../../types/search'
import { createListMessage, validateListResultPayload } from '../../query/codec'
import type { ListEntryWire, ListPayload, SortField } from '../../transport/types'
import { routableAllocation } from '../routable-allocation'
import { restoreVectorValues } from '../vector-bytes'
import { listLocalPage } from './local-list-page'
import { type ClusterReadDeps, gatherFromEveryPartition, sendReadRequest } from './scatter'
import { keepsAnyVectorField } from './vector-reads'

function clampListLimit(limit: number | undefined): number {
  const clamped = Math.max(1, clampLimit(limit))
  requireWithinResultWindow(clamped, 0)
  return clamped
}

function wireFieldsFor(projection: ResolvedProjection, sortFieldNames: string[]): string[] | null {
  if (projection.kind === 'none') {
    return sortFieldNames
  }
  if (projection.kind !== 'fields' || projection.include === null) {
    return null
  }
  const fields = new Set(projection.include.map(path => path.join('.')))
  for (const sortField of sortFieldNames) {
    fields.add(sortField)
  }
  return Array.from(fields)
}

export async function listCluster<T = AnyDocument>(
  deps: ClusterReadDeps,
  indexName: string,
  params: ListParams,
): Promise<ListResult<T>> {
  const allocation = await routableAllocation(deps.config.coordinator, indexName)
  if (allocation === null) {
    return deps.engine.listDocuments<T>(indexName, params)
  }

  const startTime = now()
  const limit = clampListLimit(params.limit)
  const signature = sortSignatureOf(params.sort)
  const binding = listBindingOf(params.filters)
  if (params.cursor !== undefined) {
    requireMatchingCursor(decodePageCursor(params.cursor), params.cursor, signature, false, binding)
  }

  const normalizedSort = normalizeSort(params.sort)
  const sortFieldNames = normalizedSort.length === 0 ? null : normalizedSort.map(entry => entry.field)
  const directions = normalizedSort.map(entry => entry.direction)
  const settings = await deps.vectorReads.settingsOf(indexName, allocation)
  const projection = resolveProjection(params.document, settings)

  const wireSort: SortField[] | null = sortFieldNames === null ? null : normalizedSort
  const payload: ListPayload = {
    indexName,
    partitionIds: [],
    cursor: params.cursor ?? null,
    limit,
    filters: (params.filters as Record<string, unknown> | undefined) ?? null,
    sort: wireSort,
    fields: wireFieldsFor(projection, sortFieldNames ?? []),
    ...(keepsAnyVectorField(projection, settings) ? {} : { vectors: false }),
  }

  const gathered = await gatherFromEveryPartition(
    allocation,
    indexName,
    group => {
      if (group.nodeId === deps.nodeId) {
        return listLocalPage(deps.engine, { ...payload, partitionIds: group.partitionIds })
      }
      const message = createListMessage({ ...payload, partitionIds: group.partitionIds }, deps.nodeId)
      return sendReadRequest(deps, group.nodeId, message, indexName, validateListResultPayload, true)
    },
    deps.readLiveAllocation,
  )

  let total = 0
  let nodeReportsMore = false
  const merged: Array<{ entry: ListEntryWire; key: readonly ComparableSortValue[] | null }> = []
  for (const result of gathered) {
    total += result.total
    nodeReportsMore = nodeReportsMore || result.hasMore
    for (const entry of result.entries) {
      merged.push({
        entry,
        key: sortFieldNames === null ? null : (entry.sortValues ?? []).map(toComparableSortValue),
      })
    }
  }

  const { compareComparableKeys } = requireLoadedOptionalReads()
  merged.sort((a, b) => {
    if (sortFieldNames !== null) {
      const byKey = compareComparableKeys(a.key ?? [], b.key ?? [], directions)
      if (byKey !== 0) {
        return byKey
      }
    }
    return compareCodePoints(a.entry.docId, b.entry.docId)
  })

  const hasMore = merged.length > limit || nodeReportsMore
  const page = merged.length > limit ? merged.slice(0, limit) : merged
  const last = page[page.length - 1]

  let cursor: string | null = null
  if (hasMore && last !== undefined) {
    cursor = encodePageCursor({
      anchor: last.entry.docId,
      score: null,
      sortKey: sortFieldNames === null ? null : [...(last.key ?? [])],
      sortSignature: signature,
      binding,
    })
  }

  const documents: Array<ListedDocument<T>> = page.map(item => ({
    id: item.entry.docId,
    document: (projection.kind === 'none'
      ? {}
      : applyProjection(restoreVectorValues(item.entry.document) as AnyDocument, projection)) as T,
  }))

  return { documents, cursor, total, elapsed: now() - startTime }
}
