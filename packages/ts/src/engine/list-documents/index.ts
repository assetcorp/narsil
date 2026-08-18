import { compareCodePoints, compareComparableKeys } from '../../core/ordering'
import type { PartitionFilterMatches, PartitionIndex, SortedPageEntry } from '../../core/partition'
import { resolveProjection } from '../../core/projection'
import type { PartitionManager } from '../../partitioning/manager'
import { flattenSchema } from '../../schema/validator'
import {
  decodePageCursor,
  encodePageCursor,
  type PageCursor,
  requireMatchingCursor,
  sortSignatureOf,
} from '../../search/cursor'
import { requireWithinResultWindow } from '../../search/pagination'
import { normalizeSort, requireSortableFields } from '../../search/sorting'
import type { FilterExpression } from '../../types/filters'
import type { ListedDocument, ListResult } from '../../types/results'
import type { AnyDocument, SchemaDefinition } from '../../types/schema'
import type { ListParams, SortSpec } from '../../types/search'
import { clampLimit, now } from '../validation'

export interface ListContext {
  manager: PartitionManager
  schema: SchemaDefinition
  partitionIds?: number[]
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

interface FilteredPartitions {
  matchesFor(partitionIndex: number): PartitionFilterMatches | null
  total: number
}

function collectFilterMatches(
  partitions: PartitionIndex[],
  filters: FilterExpression,
  schema: SchemaDefinition,
): FilteredPartitions {
  const perPartition = partitions.map(partition => partition.filterMatches(filters, schema))
  let total = 0
  for (const matches of perPartition) total += matches.count
  return { matchesFor: (partitionIndex: number) => perPartition[partitionIndex] ?? null, total }
}

function collectCandidates(
  partition: PartitionIndex,
  anchor: string | null,
  matches: PartitionFilterMatches | null,
  wanted: number,
  out: string[],
): void {
  const sorted = partition.sortedDocIds()
  let index = anchor === null ? 0 : firstIdAfter(sorted, anchor)
  let taken = 0
  while (index < sorted.length && taken < wanted) {
    const docId = sorted[index]
    index++
    if (matches !== null && !matches.hasExternal(docId)) continue
    out.push(docId)
    taken++
  }
}

function pageInIdOrder(
  partitions: PartitionIndex[],
  cursor: PageCursor | null,
  filtered: FilteredPartitions | null,
  limit: number,
): DocumentPage {
  const anchor = cursor === null ? null : cursor.anchor
  const candidates: string[] = []
  for (let index = 0; index < partitions.length; index++) {
    collectCandidates(
      partitions[index],
      anchor,
      filtered === null ? null : filtered.matchesFor(index),
      limit + 1,
      candidates,
    )
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
  filtered: FilteredPartitions | null,
  limit: number,
  sort: SortSpec,
  signature: string,
  schema: SchemaDefinition,
): DocumentPage {
  const normalized = normalizeSort(sort)
  const fields = normalized.map(entry => entry.field)
  const directions = normalized.map(entry => entry.direction)
  const flatSchema = flattenSchema(schema)
  const fieldTypes = fields.map(field => flatSchema[field])

  const request = {
    fields,
    directions,
    fieldTypes,
    limit: limit + 1,
    anchorKey: cursor === null ? null : cursor.sortKey,
    anchorId: cursor === null ? null : cursor.anchor,
  }

  const merged: SortedPageEntry[] = []
  for (let index = 0; index < partitions.length; index++) {
    const matches = filtered === null ? null : filtered.matchesFor(index)
    for (const entry of partitions[index].sortedPage({ ...request, matches })) merged.push(entry)
  }
  merged.sort((a, b) => compareComparableKeys(a.key, b.key, directions) || compareCodePoints(a.id, b.id))

  const hasMore = merged.length > limit
  const page = hasMore ? merged.slice(0, limit) : merged
  const last = page[page.length - 1]
  const nextCursor =
    hasMore && last !== undefined ? { anchor: last.id, score: null, sortKey: last.key, sortSignature: signature } : null

  return { ids: page.map(entry => entry.id), nextCursor }
}

function countAcrossPartitions(
  manager: PartitionManager,
  partitionIds: number[] | undefined,
  partitions: PartitionIndex[],
): number {
  if (partitionIds === undefined) {
    return manager.countDocuments()
  }
  let total = 0
  for (const partition of partitions) {
    total += partition.count()
  }
  return total
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
  requireSortableFields(params.sort, schema)

  let cursor: PageCursor | null = null
  if (params.cursor !== undefined) {
    cursor = decodePageCursor(params.cursor)
    requireMatchingCursor(cursor, params.cursor, signature, false)
  }

  const partitions =
    context.partitionIds === undefined
      ? manager.getAllPartitions()
      : context.partitionIds
          .map(partitionId => manager.partitionAt(partitionId))
          .filter((partition): partition is NonNullable<typeof partition> => partition !== undefined)
  const filtered = params.filters === undefined ? null : collectFilterMatches(partitions, params.filters, schema)
  const total = filtered === null ? countAcrossPartitions(manager, context.partitionIds, partitions) : filtered.total

  const page =
    params.sort === undefined || signature === null
      ? pageInIdOrder(partitions, cursor, filtered, limit)
      : pageInSortOrder(partitions, cursor, filtered, limit, params.sort, signature, schema)

  const projection = resolveProjection(params.document)

  const documents: Array<ListedDocument<T>> = []
  for (const docId of page.ids) {
    if (projection.kind === 'none') {
      documents.push({ id: docId, document: {} as T })
      continue
    }
    const stored = manager.get(docId, projection)
    if (stored === undefined) continue
    documents.push({ id: docId, document: stored as T })
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
