import { ErrorCodes, NarsilError } from '../errors'
import { isStringValuedBase, parsedTypeOf } from '../schema/validator/field-type'
import { flattenSchema } from '../schema/validator/schema'
import { normalizeSort } from '../search/sorting'
import type { SchemaDefinition } from '../types/schema'
import type { QueryParams } from '../types/search'
import { DEFAULT_RERANK_WINDOW } from './constants'
import { rerankQueryTextOf } from './query-text'

export interface ResolvedRerank {
  adapter: string
  fields: string[]
  query: string
  window: number
}

function invalid(message: string, details: Record<string, unknown> = {}): NarsilError {
  return new NarsilError(ErrorCodes.RERANK_CONFIG_INVALID, message, details)
}

function requireTextFields(fields: unknown, schema: SchemaDefinition): string[] {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw invalid('rerank.fields must list at least one text field')
  }
  const flat = flattenSchema(schema)
  const checked: string[] = []
  const seen = new Set<string>()
  for (const field of fields) {
    if (typeof field !== 'string') {
      throw invalid('rerank.fields accepts field paths written as strings', { field: String(field) })
    }
    const parsed = parsedTypeOf(Object.hasOwn(flat, field) ? flat[field] : undefined)
    if (parsed === undefined || !isStringValuedBase(parsed.base)) {
      throw invalid(`rerank.fields gives "${field}", which the schema does not declare as a text field`, { field })
    }
    if (seen.has(field)) {
      throw invalid(`rerank.fields gives "${field}" more than once`, { field })
    }
    seen.add(field)
    checked.push(field)
  }
  return checked
}

function requireWindow(window: unknown, maxWindow: number): number {
  if (window === undefined) return Math.min(DEFAULT_RERANK_WINDOW, maxWindow)
  if (typeof window !== 'number' || !Number.isInteger(window) || window < 1 || window > maxWindow) {
    throw invalid(`rerank.window must be a whole number from 1 to ${maxWindow}`, {
      window: typeof window === 'number' ? window : String(window),
      maxRerankWindow: maxWindow,
    })
  }
  return window
}

export function resolveRerankParams(params: QueryParams, schema: SchemaDefinition, maxWindow: number): ResolvedRerank {
  const rerank: unknown = params.rerank
  if (typeof rerank !== 'object' || rerank === null || Array.isArray(rerank)) {
    throw invalid('rerank must be an object that gives an adapter and the fields to rerank by')
  }
  if (normalizeSort(params.sort).length > 0) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_MODE,
      'A query cannot carry both rerank and a sort, because each of them sets the order of the hits',
    )
  }
  const { adapter, fields, window } = rerank as Record<string, unknown>
  if (typeof adapter !== 'string' || adapter.length === 0) {
    throw invalid('rerank.adapter must give the name of a registered rerank adapter')
  }
  const checkedFields = requireTextFields(fields, schema)
  const checkedWindow = requireWindow(window, maxWindow)
  const query = rerankQueryTextOf(params)
  if (query === undefined) {
    throw invalid('A reranked query needs text to compare each hit with: set rerank.query, term, or vector.text')
  }
  return { adapter, fields: checkedFields, query, window: checkedWindow }
}

export function rerankTextOf(values: readonly unknown[] | undefined): string {
  if (values === undefined) return ''
  const lines: string[] = []
  for (const value of values) {
    if (typeof value === 'string') {
      lines.push(value)
    } else if (Array.isArray(value)) {
      for (const member of value) if (typeof member === 'string') lines.push(member)
    }
  }
  return lines.join('\n')
}
