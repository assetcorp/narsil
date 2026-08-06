import type { PartitionIndex } from '../core/partition'
import { ErrorCodes, NarsilError } from '../errors'
import type { PartitionManager } from '../partitioning/manager'
import { decodeCursorText, encodeCursorText } from '../search/cursor-codec'
import type { FilterExpression } from '../types/filters'
import type { ListedDocument, ListResult } from '../types/results'
import type { AnyDocument, SchemaDefinition } from '../types/schema'
import type { ListParams } from '../types/search'
import { applyProjection, projectionKeepsField, resolveProjection } from './query/projection'
import { clampLimit, now } from './validation'

const CURSOR_VERSION = 1
const MAX_CURSOR_LENGTH = 4096
const MAX_ANCHOR_LENGTH = 512

export interface ListContext {
  manager: PartitionManager
  schema: SchemaDefinition
}

function invalidCursor(cursor: string, reason: string): NarsilError {
  return new NarsilError(ErrorCodes.SEARCH_INVALID_CURSOR, `Failed to decode listing cursor: ${reason}`, { cursor })
}

function encodeListCursor(anchor: string): string {
  return encodeCursorText(JSON.stringify({ v: CURSOR_VERSION, a: anchor }))
}

function decodeListCursor(cursor: string): string {
  if (cursor.length > MAX_CURSOR_LENGTH) throw invalidCursor(cursor, 'the cursor is too long')

  let json: string
  try {
    json = decodeCursorText(cursor)
  } catch {
    throw invalidCursor(cursor, 'invalid base64 encoding')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw invalidCursor(cursor, 'invalid JSON')
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidCursor(cursor, 'expected an object')
  }

  const { v, a } = parsed as Record<string, unknown>
  if (v !== CURSOR_VERSION) throw invalidCursor(cursor, `unsupported cursor version ${String(v)}`)
  if (typeof a !== 'string' || a.length === 0) throw invalidCursor(cursor, '"a" must be a non-empty string')
  if (a.length > MAX_ANCHOR_LENGTH) throw invalidCursor(cursor, '"a" is too long to be a document id')

  return a
}

function clampListLimit(limit: number | undefined): number {
  return Math.max(1, clampLimit(limit))
}

function firstIdAfter(sorted: readonly string[], anchor: string): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (sorted[mid] <= anchor) low = mid + 1
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

/**
 * Builds one page of stored documents in document-id order.
 *
 * @param params - The cursor, page size, filter, and projection the caller asked for.
 * @param context - The partition manager holding the documents, and the index schema.
 * @returns The page, the cursor that reaches the next one, and how many documents the listing covers in total.
 */
export function executeListDocuments<T = AnyDocument>(params: ListParams, context: ListContext): ListResult<T> {
  const { manager, schema } = context
  const startTime = now()
  const limit = clampListLimit(params.limit)
  const anchor = params.cursor === undefined ? null : decodeListCursor(params.cursor)

  const partitions = manager.getAllPartitions()
  const matches = params.filters === undefined ? null : collectFilterMatches(partitions, params.filters, schema)
  const total = matches === null ? manager.countDocuments() : matches.size

  const candidates: string[] = []
  for (const partition of partitions) {
    collectCandidates(partition, anchor, matches, limit + 1, candidates)
  }
  candidates.sort()

  const hasMore = candidates.length > limit
  const pageIds = hasMore ? candidates.slice(0, limit) : candidates

  const projection = resolveProjection(params.document)
  const keepVectorField = (fieldPath: string): boolean => projectionKeepsField(projection, fieldPath)

  const documents: Array<ListedDocument<T>> = []
  for (const docId of pageIds) {
    if (projection.kind === 'none') {
      documents.push({ id: docId, document: {} as T })
      continue
    }
    const stored = manager.get(docId, keepVectorField)
    if (stored === undefined) continue
    documents.push({ id: docId, document: applyProjection(stored, projection) as T })
  }

  if (!hasMore) {
    for (const partition of partitions) partition.releaseSortedDocIds()
  }

  return {
    documents,
    cursor: hasMore ? encodeListCursor(pageIds[pageIds.length - 1]) : null,
    total,
    elapsed: now() - startTime,
  }
}
