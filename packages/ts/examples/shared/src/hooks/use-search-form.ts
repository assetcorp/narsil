import type { FilterExpression, QueryParams, TermMatchPolicy } from '@delali/narsil'
import { useCallback, useMemo, useState } from 'react'

export interface SearchFormValues {
  term: string
  fields: string[]
  boost: Record<string, number>
  sort: Record<string, 'asc' | 'desc'>
  limit: number
  offset: number
  tolerance: number
  termMatch: TermMatchPolicy
  exact: boolean
  minScore: number
  facets: Record<string, Record<string, unknown>>
  filters: FilterExpression
  groupField: string
  highlightFields: string[]
  paginationMode: 'offset' | 'cursor'
  searchAfter?: string
}

const EMPTY_VALUES: SearchFormValues = {
  term: '',
  fields: [],
  boost: {},
  sort: {},
  limit: 20,
  offset: 0,
  tolerance: 0,
  termMatch: 'any',
  exact: false,
  minScore: 0,
  facets: {},
  filters: {},
  groupField: '',
  highlightFields: [],
  paginationMode: 'offset',
  searchAfter: undefined,
}

export interface SearchForm {
  values: SearchFormValues
  setTerm: (term: string) => void
  setFields: (fields: string[]) => void
  setBoost: (field: string, value: number) => void
  setSort: (field: string, direction: 'asc' | 'desc' | null) => void
  setFilters: (filters: FilterExpression) => void
  setPage: (page: number) => void
  loadMore: (cursor: string | undefined) => void
  setValue: <K extends keyof SearchFormValues>(key: K, value: SearchFormValues[K]) => void
}

export function toQueryParams(values: SearchFormValues): QueryParams {
  const params: QueryParams = {
    term: values.term,
    limit: values.limit,
    includeScoreComponents: true,
  }

  if (values.fields.length > 0) params.fields = values.fields
  if (Object.keys(values.boost).length > 0) params.boost = values.boost
  if (Object.keys(values.sort).length > 0) params.sort = values.sort
  if (values.tolerance > 0) params.tolerance = values.tolerance
  if (values.termMatch !== 'any') params.termMatch = values.termMatch
  if (values.exact) params.exact = true
  if (values.minScore > 0) params.minScore = values.minScore
  if (Object.keys(values.facets).length > 0) params.facets = values.facets
  if (Object.keys(values.filters).length > 0) params.filters = values.filters
  if (values.highlightFields.length > 0) {
    params.highlight = { fields: values.highlightFields, preTag: '<mark>', postTag: '</mark>' }
  }
  if (values.paginationMode === 'offset') {
    params.offset = values.offset
  } else if (values.searchAfter !== undefined) {
    params.searchAfter = values.searchAfter
  }
  if (values.groupField.length > 0) {
    params.group = { fields: [values.groupField], maxPerGroup: 3 }
  }

  return params
}

/**
 * Holds every control on the search form. It reads and writes nothing, so the
 * page that owns it decides how the parameters reach an index.
 */
export function useSearchForm(initialTerm?: string): SearchForm {
  const [values, setValues] = useState<SearchFormValues>(() =>
    initialTerm ? { ...EMPTY_VALUES, term: initialTerm } : EMPTY_VALUES,
  )

  const setTerm = useCallback((term: string) => {
    setValues(current => ({ ...current, term, offset: 0, searchAfter: undefined }))
  }, [])

  const setFields = useCallback((fields: string[]) => {
    setValues(current => ({ ...current, fields, offset: 0 }))
  }, [])

  const setBoost = useCallback((field: string, value: number) => {
    setValues(current => {
      const boost = { ...current.boost }
      if (value === 1) {
        delete boost[field]
      } else {
        boost[field] = value
      }
      return { ...current, boost }
    })
  }, [])

  const setSort = useCallback((field: string, direction: 'asc' | 'desc' | null) => {
    setValues(current => {
      const sort = { ...current.sort }
      if (direction === null) {
        delete sort[field]
        return { ...current, sort }
      }
      return { ...current, sort: { [field]: direction, ...sort } }
    })
  }, [])

  const setFilters = useCallback((filters: FilterExpression) => {
    setValues(current => ({ ...current, filters, offset: 0 }))
  }, [])

  const setPage = useCallback((page: number) => {
    setValues(current => ({ ...current, offset: page * current.limit, searchAfter: undefined }))
  }, [])

  const loadMore = useCallback((cursor: string | undefined) => {
    if (cursor === undefined) return
    setValues(current => ({ ...current, searchAfter: cursor }))
  }, [])

  const setValue = useCallback(<K extends keyof SearchFormValues>(key: K, value: SearchFormValues[K]) => {
    setValues(current => ({ ...current, [key]: value, offset: 0 }))
  }, [])

  return useMemo(
    () => ({ values, setTerm, setFields, setBoost, setSort, setFilters, setPage, loadMore, setValue }),
    [values, setTerm, setFields, setBoost, setSort, setFilters, setPage, loadMore, setValue],
  )
}
