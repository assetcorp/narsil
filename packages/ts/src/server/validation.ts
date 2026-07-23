import type { QueryParams, SuggestParams } from '../types/search'
import type { BatchBody, CreateIndexRequest, DocumentBody, InsertBody, MultiGetBody, RebalanceBody } from './types'

/**
 * Outcome of a request-shape check. A `null` return means the request is
 * acceptable; a value carries the client-facing message and optional details for
 * a 400. Validators here are pure and take the resolved limits as arguments, so
 * they hold no engine or transport dependencies and stay usable from the core
 * server without pulling in the distributed query stack.
 */
export interface ValidationFailure {
  message: string
  details?: Record<string, unknown>
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function overWindow(field: string, value: unknown, maxWindow: number): ValidationFailure | null {
  if (typeof value === 'number' && value > maxWindow) {
    return {
      message: `Field "${field}" exceeds the maximum result window of ${maxWindow}`,
      details: { value, limit: maxWindow },
    }
  }
  return null
}

/**
 * Rejects a query that would build an unbounded result set. Every field that
 * multiplies the number of returned rows is enumerated here in one place, so a
 * new amplifying field is bounded by adding a line rather than by remembering to
 * patch a handler. Custom group reducers are functions and cannot cross JSON, so
 * they are refused outright.
 */
export function validateQuery(params: QueryParams, maxWindow: number): ValidationFailure | null {
  if (params.group && typeof params.group === 'object' && 'reduce' in params.group) {
    return {
      message: 'Custom group reducers are not available over HTTP; use "group.fields" and "group.maxPerGroup" only',
    }
  }
  const rowBound = overWindow('limit', params.limit, maxWindow) ?? overWindow('offset', params.offset, maxWindow)
  if (rowBound) return rowBound
  if (params.group && typeof params.group === 'object') {
    const grouped = overWindow('group.maxPerGroup', (params.group as { maxPerGroup?: unknown }).maxPerGroup, maxWindow)
    if (grouped) return grouped
  }
  if (params.facets && typeof params.facets === 'object') {
    for (const [field, facet] of Object.entries(params.facets)) {
      if (facet && typeof facet === 'object') {
        const faceted = overWindow(`facets.${field}.limit`, (facet as { limit?: unknown }).limit, maxWindow)
        if (faceted) return faceted
      }
    }
  }
  return null
}

export function validateSuggest(params: SuggestParams): ValidationFailure | null {
  if (typeof params.prefix !== 'string') {
    return { message: 'Field "prefix" is required and must be a string' }
  }
  return null
}

export function validateDocumentBody(body: DocumentBody | InsertBody): ValidationFailure | null {
  if (!isPlainObject(body.document)) {
    return { message: 'Field "document" is required and must be an object' }
  }
  return null
}

export function validateMultiGet(body: MultiGetBody, maxFetch: number): ValidationFailure | null {
  if (!Array.isArray(body.docIds)) {
    return { message: 'Field "docIds" is required and must be an array of strings' }
  }
  if (body.docIds.length > maxFetch) {
    return {
      message: `Field "docIds" exceeds the maximum of ${maxFetch} ids per request`,
      details: { count: body.docIds.length, limit: maxFetch },
    }
  }
  return null
}

export function validateBatch(body: BatchBody): ValidationFailure | null {
  const action = body.action ?? 'insert'
  if (action === 'insert') {
    if (!Array.isArray(body.documents)) return { message: 'Batch insert requires a "documents" array' }
    return null
  }
  if (action === 'update') {
    if (!Array.isArray(body.updates)) return { message: 'Batch update requires an "updates" array' }
    return null
  }
  if (action === 'delete') {
    if (!Array.isArray(body.docIds)) return { message: 'Batch delete requires a "docIds" array' }
    return null
  }
  return { message: 'Field "action" must be one of "insert", "update", or "delete"' }
}

export function validateCreateIndex(body: CreateIndexRequest): ValidationFailure | null {
  if (typeof body.name !== 'string' || body.name.length === 0) {
    return { message: 'Field "name" is required and must be a non-empty string' }
  }
  if (!isPlainObject(body.config)) {
    return { message: 'Field "config" is required and must be an object' }
  }
  return null
}

export function validateRebalance(body: RebalanceBody): ValidationFailure | null {
  const target = body.targetPartitionCount
  if (typeof target !== 'number' || !Number.isInteger(target) || target <= 0) {
    return { message: 'Field "targetPartitionCount" is required and must be a positive integer' }
  }
  return null
}
