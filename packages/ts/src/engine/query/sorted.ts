import { type ComparableSortValue, compareCodePoints, compareComparableKeys } from '../../core/ordering'
import type { SortedPageEntry } from '../../core/partition'
import { flattenSchema } from '../../schema/validator'
import { decodePageCursor, encodePageCursor, requireMatchingCursor } from '../../search/cursor'
import { mergeFacets } from '../../search/facets'
import { fulltextMatches } from '../../search/fulltext'
import { normalizeSort } from '../../search/sorting'
import type { FacetResult, Hit } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import { partitionsFor, type QueryContext, searchOptionsFor } from './shared'

/**
 * Reports whether a sorted query ranks by sort values alone, which is what
 * lets it skip scoring and read a bounded page from the sort columns. Scores
 * are still computed where the caller asks for them, where a score floor has
 * to apply, or where grouping, pinning, or a term-coverage policy reads them.
 */
export function sortsWithoutScores(params: QueryParams): boolean {
  return (
    params.includeScores !== true &&
    params.includeScoreComponents !== true &&
    params.minScore === undefined &&
    params.group === undefined &&
    params.pinned === undefined &&
    (params.termMatch === undefined || params.termMatch === 'any')
  )
}

export interface SortedQueryPage<T = AnyDocument> {
  hits: Array<Hit<T>>
  count: number
  cursor?: string
  facets?: Record<string, FacetResult>
}

/**
 * Answers a sorted full-text query without scoring: each partition walks its
 * postings once into a match bitset, streams its sort columns against it for
 * one bounded page, and the pages merge by sort key. The cost is the postings
 * walk plus a page-sized selection, in place of scoring and sorting every
 * match.
 */
export function executeSortedQueryPage<T = AnyDocument>(
  params: QueryParams,
  context: QueryContext,
  limit: number,
  offset: number,
  sortSignature: string,
): SortedQueryPage<T> {
  const { manager, language, config } = context
  const schema = config.schema

  let anchorKey: ComparableSortValue[] | null = null
  let anchorId: string | null = null
  if (params.searchAfter !== undefined) {
    const decoded = decodePageCursor(params.searchAfter)
    requireMatchingCursor(decoded, params.searchAfter, sortSignature, true)
    anchorKey = decoded.sortKey
    anchorId = decoded.anchor
  }

  const normalized = normalizeSort(params.sort)
  const fields = normalized.map(entry => entry.field)
  const directions = normalized.map(entry => entry.direction)
  const flatSchema = flattenSchema(schema)
  const fieldTypes = fields.map(field => flatSchema[field])

  const options = searchOptionsFor(manager)
  const partitions = partitionsFor(manager, context.partitionIds)
  const partitionLimit = offset + limit + 1

  const merged: SortedPageEntry[] = []
  const partitionFacets: Array<Record<string, FacetResult>> = []
  let count = 0

  for (const partition of partitions) {
    const matches = fulltextMatches(partition, params, language, schema, options)
    if (params.facets !== undefined) {
      partitionFacets.push(
        partition.computeFacets(
          matches === null ? new Set<string>() : { ordinalBitset: matches.ordinalBitset() },
          params.facets,
          schema,
        ),
      )
    }
    if (matches === null || matches.count === 0) continue
    count += matches.count

    const page = partition.sortedPage({
      fields,
      directions,
      fieldTypes,
      limit: partitionLimit,
      anchorKey,
      anchorId,
      matches,
    })
    for (const entry of page) merged.push(entry)
  }

  merged.sort((a, b) => compareComparableKeys(a.key, b.key, directions) || compareCodePoints(a.id, b.id))

  const hasMore = merged.length > offset + limit
  const page = merged.slice(offset, offset + limit)
  const last = page[page.length - 1]

  let cursor: string | undefined
  if (hasMore && last !== undefined) {
    cursor = encodePageCursor({ anchor: last.id, score: null, sortKey: last.key, sortSignature })
  }

  return {
    hits: page.map(entry => ({ id: entry.id, document: undefined as unknown as T })),
    count,
    cursor,
    facets: partitionFacets.length > 0 ? mergeFacets(partitionFacets) : undefined,
  }
}
