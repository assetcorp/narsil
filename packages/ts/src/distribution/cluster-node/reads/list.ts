import {
  type ComparableSortValue,
  compareCodePoints,
  compareComparableKeys,
  toComparableSortValue,
} from '../../../core/ordering'
import { applyProjection, type ResolvedProjection, resolveProjection } from '../../../core/projection'
import { clampLimit, now } from '../../../engine/validation'
import { decodePageCursor, encodePageCursor, requireMatchingCursor, sortSignatureOf } from '../../../search/cursor'
import { requireWithinResultWindow } from '../../../search/pagination'
import { normalizeSort, readSortValues } from '../../../search/sorting'
import type { ListedDocument, ListResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import type { ListParams } from '../../../types/search'
import { createListMessage, validateListResultPayload } from '../../query/codec'
import type { ListEntryWire, ListPayload, SortField } from '../../transport/types'
import { activeAllocation, type ClusterReadDeps, sendReadRequest, strictScatterGroups } from './scatter'

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

function toWireSortValue(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  return null
}

async function gatherLocalPage(
  deps: ClusterReadDeps,
  indexName: string,
  payload: ListPayload,
  partitionIds: number[],
  sortFieldNames: string[] | null,
): Promise<{ entries: ListEntryWire[]; total: number; hasMore: boolean }> {
  const listParams: ListParams = {
    cursor: payload.cursor ?? undefined,
    limit: payload.limit,
    filters: payload.filters ?? undefined,
    sort: payload.sort ?? undefined,
    document: payload.fields === null ? undefined : { include: payload.fields },
  }
  const result = await deps.engine.listPartitions(indexName, listParams, partitionIds)
  const entries: ListEntryWire[] = result.documents.map(listed => ({
    docId: listed.id,
    document: listed.document as Record<string, unknown>,
    sortValues:
      sortFieldNames === null
        ? null
        : readSortValues(listed.document as AnyDocument | undefined, sortFieldNames).map(toWireSortValue),
  }))
  return { entries, total: result.total, hasMore: result.cursor !== null }
}

export async function listCluster<T = AnyDocument>(
  deps: ClusterReadDeps,
  indexName: string,
  params: ListParams,
): Promise<ListResult<T>> {
  const allocation = await activeAllocation(deps, indexName)
  if (allocation === null) {
    return deps.engine.listDocuments<T>(indexName, params)
  }

  const startTime = now()
  const limit = clampListLimit(params.limit)
  const signature = sortSignatureOf(params.sort)
  if (params.cursor !== undefined) {
    requireMatchingCursor(decodePageCursor(params.cursor), params.cursor, signature, false)
  }

  const normalizedSort = normalizeSort(params.sort)
  const sortFieldNames = normalizedSort.length === 0 ? null : normalizedSort.map(entry => entry.field)
  const directions = normalizedSort.map(entry => entry.direction)
  const projection = resolveProjection(params.document)

  const wireSort: SortField[] | null = sortFieldNames === null ? null : normalizedSort
  const payload: ListPayload = {
    indexName,
    partitionIds: [],
    cursor: params.cursor ?? null,
    limit,
    filters: (params.filters as Record<string, unknown> | undefined) ?? null,
    sort: wireSort,
    fields: wireFieldsFor(projection, sortFieldNames ?? []),
  }

  const groups = strictScatterGroups(allocation, indexName)
  const gathered = await Promise.all(
    groups.map(group => {
      if (group.nodeId === deps.nodeId) {
        return gatherLocalPage(
          deps,
          indexName,
          { ...payload, partitionIds: group.partitionIds },
          group.partitionIds,
          sortFieldNames,
        )
      }
      const message = createListMessage({ ...payload, partitionIds: group.partitionIds }, deps.nodeId)
      return sendReadRequest(deps, group.nodeId, message, indexName, validateListResultPayload)
    }),
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
    })
  }

  const documents: Array<ListedDocument<T>> = page.map(item => ({
    id: item.entry.docId,
    document: (projection.kind === 'none' ? {} : applyProjection(item.entry.document as AnyDocument, projection)) as T,
  }))

  return { documents, cursor, total, elapsed: now() - startTime }
}
