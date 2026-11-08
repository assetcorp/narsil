import type { FacetConfig, QueryParams, SortField } from '@delali/narsil'
import type { SearchFormValues } from '../hooks/use-search-form'

export const MAX_FACET_RANGES = 20
export const FACET_VALUE_LIMIT = 12
export const GROUP_HITS_SHOWN = 3
export const RERANK_WINDOW = 20

const RANGE_PATTERN = /^\s*(-?\d+(?:\.\d+)?)\s*(?:to|\.\.)\s*(-?\d+(?:\.\d+)?)\s*$/

export interface FacetRange {
  from: number
  to: number
}

export interface SearchRequestContext {
  vectorField: string | null
  rerankAdapter: string
  rerankFields: string[]
  excludedFields: string[]
}

export interface SearchRequest {
  params: QueryParams
  groupTotalField: string | null
}

export function parseFacetRanges(text: string): FacetRange[] | string {
  const entries = text
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
  if (entries.length > MAX_FACET_RANGES) return `Count at most ${MAX_FACET_RANGES} ranges at once.`
  const ranges: FacetRange[] = []
  for (const entry of entries) {
    const match = RANGE_PATTERN.exec(entry)
    if (match === null) return `"${entry}" is no range. Write each one as "0 to 100000".`
    const from = Number(match[1])
    const to = Number(match[2])
    if (!(from < to)) return `The range "${entry}" has to start below where it ends.`
    ranges.push({ from, to })
  }
  return ranges
}

function sortOf(values: SearchFormValues): QueryParams['sort'] | undefined {
  const plain = Object.entries(values.sort)
  if (values.listSort === null) return plain.length > 0 ? values.sort : undefined
  const fields: SortField[] = plain.map(([field, direction]) => ({ field, direction }))
  fields.push({ field: values.listSort.field, direction: values.listSort.direction, mode: values.listSort.mode })
  return fields
}

function facetsOf(values: SearchFormValues): FacetConfig | undefined {
  if (values.facetField.length === 0) return undefined
  const ranges = parseFacetRanges(values.facetRanges)
  if (typeof ranges !== 'string' && ranges.length > 0) return { [values.facetField]: { ranges } }
  return { [values.facetField]: { limit: FACET_VALUE_LIMIT } }
}

function applyTextOptions(params: QueryParams, values: SearchFormValues): void {
  if (values.fields.length > 0) params.fields = values.fields
  if (Object.keys(values.boost).length > 0) params.boost = values.boost
  if (values.tolerance > 0) params.tolerance = values.tolerance
  if (values.termMatch !== 'any') params.termMatch = values.termMatch
  if (values.exact) params.exact = true
  if (values.prefix) params.prefix = true
  if (values.partialWords) params.partialWords = true
  if (values.minScore > 0) params.minScore = values.minScore
  if (values.highlightFields.length > 0) {
    params.highlight = { fields: values.highlightFields, preTag: '<mark>', postTag: '</mark>' }
  }
}

function applyVectorOptions(params: QueryParams, values: SearchFormValues, vectorField: string): void {
  params.mode = values.mode
  params.vector = { field: vectorField, text: values.term }
  if (values.similarity > 0) params.vector.similarity = values.similarity
  if (values.efSearch > 0) params.vector.efSearch = values.efSearch
  if (values.mode !== 'hybrid') return
  params.hybrid =
    values.hybridStrategy === 'rrf' ? { strategy: 'rrf', k: values.rrfK } : { strategy: 'linear', alpha: values.alpha }
}

export function toSearchRequest(values: SearchFormValues, context: SearchRequestContext): SearchRequest {
  const vectorMode = values.mode !== 'fulltext' && context.vectorField !== null
  const params: QueryParams = { limit: values.limit, includeScoreComponents: !vectorMode }

  if (vectorMode && context.vectorField !== null) {
    applyVectorOptions(params, values, context.vectorField)
    if (values.mode === 'hybrid') {
      params.term = values.term
      applyTextOptions(params, values)
    }
  } else {
    params.term = values.term
    applyTextOptions(params, values)
  }

  const sort = sortOf(values)
  if (sort !== undefined && values.mode !== 'hybrid') params.sort = sort
  const facets = facetsOf(values)
  if (facets !== undefined) params.facets = facets
  if (Object.keys(values.filters).length > 0) params.filters = values.filters
  if (context.excludedFields.length > 0) params.document = { exclude: context.excludedFields }

  const pinnedId = values.pinnedId.trim()
  if (pinnedId.length > 0) params.pinned = [{ docId: pinnedId, position: values.pinnedPosition }]

  if (values.rerank && context.rerankFields.length > 0) {
    params.rerank = { adapter: context.rerankAdapter, fields: context.rerankFields, window: RERANK_WINDOW }
  }

  if (values.paginationMode === 'offset') {
    params.offset = values.offset
  } else if (values.searchAfter !== undefined) {
    params.searchAfter = values.searchAfter
  }

  const grouped = values.groupField.length > 0
  if (grouped) params.group = { fields: [values.groupField], maxPerGroup: GROUP_HITS_SHOWN }
  const groupTotalField = grouped && values.groupTotalField.length > 0 ? values.groupTotalField : null

  return { params, groupTotalField }
}
