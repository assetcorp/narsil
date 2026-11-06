import type { FilterExpression, SearchMode, TermMatchPolicy } from '@delali/narsil'
import { useCallback, useMemo, useState } from 'react'

export type ListSortMode = 'min' | 'max' | 'avg' | 'median'

export interface ListSortValue {
  field: string
  direction: 'asc' | 'desc'
  mode: ListSortMode
}

export interface SearchFormValues {
  term: string
  fields: string[]
  boost: Record<string, number>
  sort: Record<string, 'asc' | 'desc'>
  listSort: ListSortValue | null
  limit: number
  offset: number
  tolerance: number
  termMatch: TermMatchPolicy
  exact: boolean
  prefix: boolean
  partialWords: boolean
  minScore: number
  facetField: string
  facetRanges: string
  filters: FilterExpression
  groupField: string
  groupTotalField: string
  pinnedId: string
  pinnedPosition: number
  rerank: boolean
  mode: SearchMode
  similarity: number
  efSearch: number
  hybridStrategy: 'rrf' | 'linear'
  rrfK: number
  alpha: number
  highlightFields: string[]
  paginationMode: 'offset' | 'cursor'
  searchAfter?: string
}

export const DEFAULT_RRF_K = 60
export const DEFAULT_HYBRID_ALPHA = 0.5
export const DEFAULT_EF_SEARCH = 0

const EMPTY_VALUES: SearchFormValues = {
  term: '',
  fields: [],
  boost: {},
  sort: {},
  listSort: null,
  limit: 20,
  offset: 0,
  tolerance: 0,
  termMatch: 'any',
  exact: false,
  prefix: false,
  partialWords: false,
  minScore: 0,
  facetField: '',
  facetRanges: '',
  filters: {},
  groupField: '',
  groupTotalField: '',
  pinnedId: '',
  pinnedPosition: 0,
  rerank: false,
  mode: 'fulltext',
  similarity: 0,
  efSearch: DEFAULT_EF_SEARCH,
  hybridStrategy: 'rrf',
  rrfK: DEFAULT_RRF_K,
  alpha: DEFAULT_HYBRID_ALPHA,
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
