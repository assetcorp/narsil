import { compareCodePoints } from '../../core/ordering'
import type { PartitionIndex } from '../../core/partition'
import type { PartitionManager } from '../../partitioning/manager'
import {
  decodePageCursor,
  encodePageCursor,
  type PageCursor,
  requireMatchingCursor,
  sortSignatureOf,
} from '../../search/cursor'
import { requireWithinResultWindow } from '../../search/pagination'
import type { FilterExpression } from '../../types/filters'
import type { ListedDocument, ListResult } from '../../types/results'
import type { AnyDocument, SchemaDefinition } from '../../types/schema'
import type { ListParams, SortSpec } from '../../types/search'
import { applyProjection, projectionKeepsField, resolveProjection } from '../query/projection'
import { clampLimit, now } from '../validation'
import { selectSortedPage } from './sort'

export interface ListContext {
  manager: PartitionManager
  schema: SchemaDefinition
}

interface DocumentPage {
  ids: string[]
  nextCursor: PageCursor | null
}

function clampListLimit(limit: number | undefined): number {
  const clamped = Math.max(1, clampLimit(limit))
  requireWithinResultWindow(clamped, 0)
  return clamped
}

function firstIdAfter(sorted: readonly string[], anchor: string): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (compareCodePoints(sorted[mid], anchor) <= 0) low = mid + 1
    else high = mid
  }
  return low
}

function collectFilterMatches(
  partitions: PartitionIndex[],
  filters: FilterExpression,
  schema: SchemaDefinition,
): Set<string> {
  const matches = new Set<string>()
  for (const partition of partitions) {
    for (const docId of partition.applyFilters(filters, schema)) matches.add(docId)
  }
  return matches
}

function collectCandidates(
  partition: PartitionIndex,
  anchor: string | null,
  matches: Set<string> | null,
  wanted: number,
  out: string[],
): void {
  const sorted = partition.sortedDocIds()
  let index = anchor === null ? 0 : firstIdAfter(sorted, anchor)
  let taken = 0
  while (index < sorted.length && taken < wanted) {
    const docId = sorted[index]
    index++
    if (matches !== null && !matches.has(docId)) continue
    out.push(docId)
    taken++
  }
}

function pageInIdOrder(
  partitions: PartitionIndex[],
  cursor: PageCursor | null,
  matches: Set<string> | null,
  limit: number,
): DocumentPage {
  const anchor = cursor === null ? null : cursor.anchor
  const candidates: string[] = []
  for (const partition of partitions) {
    collectCandidates(partition, anchor, matches, limit + 1, candidates)
  }
  candidates.sort(compareCodePoints)

  const hasMore = candidates.length > limit
  const ids = hasMore ? candidates.slice(0, limit) : candidates
  const nextCursor =
    hasMore && ids.length > 0 ? { anchor: ids[ids.length - 1], score: null, sortKey: null, sortSignature: null } : null

  return { ids, nextCursor }
}

function pageInSortOrder(
  partitions: PartitionIndex[],
  cursor: PageCursor | null,
  matches: Set<string> | null,
  limit: number,
  sort: SortSpec,
  signature: string,
  manager: PartitionManager,
): DocumentPage {
  const candidates: string[] = []
  for (const partition of partitions) {
    for (const docId of partition.sortedDocIds()) {
      if (matches !== null && !matches.has(docId)) continue
      candidates.push(docId)
    }
  }

  const selection = selectSortedPage(
    candidates,
    sort,
    docId => manager.getRef(docId),
    limit,
    cursor === null ? null : cursor.sortKey,
    cursor === null ? null : cursor.anchor,
  )

  const last = selection.page[selection.page.length - 1]
  const hasMore = selection.matching > selection.page.length
  const nextCursor =
    hasMore && last !== undefined ? { anchor: last.id, score: null, sortKey: last.key, sortSignature: signature } : null

  return { ids: selection.page.map(entry => entry.id), nextCursor }
}

/**
 * Builds one page of stored documents, in document-id order by default and in
 * the caller's sort order when they ask for one.
 *
 * @param params - The cursor, page size, filter, sort, and projection the caller asked for.
 * @param context - The partition manager holding the documents, and the index schema.
 * @returns The page, the cursor that reaches the next one, and how many documents the listing covers in total.
 */
export function executeListDocuments<T = AnyDocument>(params: ListParams, context: ListContext): ListResult<T> {
  const { manager, schema } = context
  const startTime = now()
  const limit = clampListLimit(params.limit)
  const signature = sortSignatureOf(params.sort)

  let cursor: PageCursor | null = null
  if (params.cursor !== undefined) {
    cursor = decodePageCursor(params.cursor)
    requireMatchingCursor(cursor, params.cursor, signature, false)
  }

  const partitions = manager.getAllPartitions()
  const matches = params.filters === undefined ? null : collectFilterMatches(partitions, params.filters, schema)
  const total = matches === null ? manager.countDocuments() : matches.size

  const page =
    params.sort === undefined || signature === null
      ? pageInIdOrder(partitions, cursor, matches, limit)
      : pageInSortOrder(partitions, cursor, matches, limit, params.sort, signature, manager)

  const projection = resolveProjection(params.document)
  const keepVectorField = (fieldPath: string): boolean => projectionKeepsField(projection, fieldPath)

  const documents: Array<ListedDocument<T>> = []
  for (const docId of page.ids) {
    if (projection.kind === 'none') {
      documents.push({ id: docId, document: {} as T })
      continue
    }
    const stored = manager.get(docId, keepVectorField)
    if (stored === undefined) continue
    documents.push({ id: docId, document: applyProjection(stored, projection) as T })
  }

  if (page.nextCursor === null) {
    for (const partition of partitions) partition.releaseSortedDocIds()
  }

  return {
    documents,
    cursor: page.nextCursor === null ? null : encodePageCursor(page.nextCursor),
    total,
    elapsed: now() - startTime,
  }
}
