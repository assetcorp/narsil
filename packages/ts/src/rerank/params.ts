import { ErrorCodes, NarsilError } from '../errors'
import type { SchemaDefinition } from '../types/schema'
import type { QueryParams } from '../types/search'
import { DEFAULT_RERANK_WINDOW, MIN_RERANK_WINDOW } from './constants'
import type { RuntimeHost } from './host'
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

function requireTextFields(fields: unknown, schema: SchemaDefinition, host: RuntimeHost): string[] {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw invalid('rerank.fields must list at least one text field')
  }
  const flat = host.flattenSchema(schema)
  const checked: string[] = []
  const seen = new Set<string>()
  for (const field of fields) {
    if (typeof field !== 'string') {
      throw invalid('rerank.fields accepts field paths written as strings', { field: String(field) })
    }
    const parsed = host.parsedTypeOf(Object.hasOwn(flat, field) ? flat[field] : undefined)
    if (parsed === undefined || !host.isStringValuedBase(parsed.base)) {
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

function requireWindow(window: unknown, maxWindow: number, hybridDepth: number | undefined): number {
  if (window === undefined) return Math.min(DEFAULT_RERANK_WINDOW, maxWindow, hybridDepth ?? maxWindow)
  if (typeof window !== 'number' || !Number.isInteger(window) || window < MIN_RERANK_WINDOW || window > maxWindow) {
    throw invalid(`rerank.window must be a whole number from ${MIN_RERANK_WINDOW} to ${maxWindow}`, {
      window: typeof window === 'number' ? window : String(window),
      maxRerankWindow: maxWindow,
    })
  }
  if (hybridDepth !== undefined && window > hybridDepth) {
    throw invalid(
      `rerank.window is ${window}, above the hybrid.depth of ${hybridDepth} that a hybrid query reranks from`,
      {
        window,
        depth: hybridDepth,
      },
    )
  }
  return window
}

export function resolveRerankParams(
  params: QueryParams,
  schema: SchemaDefinition,
  maxWindow: number,
  hybridDepth: number | undefined,
  host: RuntimeHost,
): ResolvedRerank {
  const rerank: unknown = params.rerank
  if (typeof rerank !== 'object' || rerank === null || Array.isArray(rerank)) {
    throw invalid('rerank must be an object that gives an adapter and the fields to rerank by')
  }
  if (host.normalizeSort(params.sort).length > 0) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_MODE,
      'A query cannot carry both rerank and a sort, because each of them sets the order of the hits',
    )
  }
  const { adapter, fields, window } = rerank as Record<string, unknown>
  if (typeof adapter !== 'string' || adapter.length === 0) {
    throw invalid('rerank.adapter must give the name of a registered rerank adapter')
  }
  const checkedFields = requireTextFields(fields, schema, host)
  const checkedWindow = requireWindow(window, maxWindow, hybridDepth)
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
