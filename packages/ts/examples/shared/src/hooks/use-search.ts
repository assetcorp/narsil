import { useCallback, useEffect, useRef, useState } from 'react'
import type { NarsilBackend, QueryRequest, QueryResponse, SuggestResponse } from '../backend'

export interface SearchParams {
  term: string
  fields: string[]
  boost: Record<string, number>
  sort: Record<string, 'asc' | 'desc'>
  limit: number
  offset: number
  tolerance: number
  termMatch: 'all' | 'any'
  exact: boolean
  minScore: number
  facets: Record<string, Record<string, unknown>>
  filters: Record<string, unknown>
  groupField: string
  highlightFields: string[]
  paginationMode: 'offset' | 'cursor'
  searchAfter?: string
}

export interface SearchState {
  results: QueryResponse | null
  isLoading: boolean
  suggestions: SuggestResponse | null
  isSuggestLoading: boolean
  error: string | null
  params: SearchParams
}

const DEFAULT_PARAMS: SearchParams = {
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

export function useSearch(backend: NarsilBackend, indexName: string | null) {
  const [state, setState] = useState<SearchState>({
    results: null,
    isLoading: false,
    suggestions: null,
    isSuggestLoading: false,
    error: null,
    params: DEFAULT_PARAMS,
  })

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchCounter = useRef(0)

  const executeSearch = useCallback(
    async (params: SearchParams) => {
      if (!indexName || !params.term.trim()) {
        setState(s => ({ ...s, results: null, isLoading: false, error: null }))
        return
      }

      const id = ++searchCounter.current
      setState(s => ({ ...s, isLoading: true, error: null }))

      try {
        const request: QueryRequest = {
          indexName,
          term: params.term,
          limit: params.limit,
          includeScoreComponents: true,
        }

        if (params.fields.length > 0) request.fields = params.fields
        if (Object.keys(params.boost).length > 0) request.boost = params.boost
        if (Object.keys(params.sort).length > 0) request.sort = params.sort
        if (params.tolerance > 0) request.tolerance = params.tolerance
        if (params.termMatch !== 'any') request.termMatch = params.termMatch
        if (params.exact) request.exact = true
        if (params.minScore > 0) request.minScore = params.minScore
        if (Object.keys(params.facets).length > 0) request.facets = params.facets
        if (Object.keys(params.filters).length > 0) request.filters = params.filters
        if (params.highlightFields.length > 0) {
          request.highlight = {
            fields: params.highlightFields,
            preTag: '<mark>',
            postTag: '</mark>',
          }
        }

        if (params.paginationMode === 'offset') {
          request.offset = params.offset
        } else if (params.searchAfter) {
          request.searchAfter = params.searchAfter
        }

        if (params.groupField) {
          request.group = { fields: [params.groupField], maxPerGroup: 3 }
        }

        const response = await backend.query(request)
        if (id !== searchCounter.current) return

        setState(s => ({ ...s, results: response, isLoading: false }))
      } catch (err) {
        if (id !== searchCounter.current) return
        setState(s => ({
          ...s,
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    },
    [backend, indexName],
  )

  const executeSuggest = useCallback(
    async (prefix: string) => {
      if (!indexName || prefix.length < 2) {
        setState(s => ({ ...s, suggestions: null, isSuggestLoading: false }))
        return
      }

      setState(s => ({ ...s, isSuggestLoading: true }))

      try {
        const response = await backend.suggest({ indexName, prefix, limit: 8 })
        setState(s => ({ ...s, suggestions: response, isSuggestLoading: false }))
      } catch {
        setState(s => ({ ...s, isSuggestLoading: false }))
      }
    },
    [backend, indexName],
  )

  const paramsRef = useRef(state.params)
  paramsRef.current = state.params

  const setTerm = useCallback(
    (term: string) => {
      setState(s => {
        const params = { ...s.params, term, offset: 0, searchAfter: undefined }
        return { ...s, params }
      })

      if (searchTimer.current) clearTimeout(searchTimer.current)
      if (suggestTimer.current) clearTimeout(suggestTimer.current)

      searchTimer.current = setTimeout(() => {
        executeSearch(paramsRef.current)
      }, 300)

      suggestTimer.current = setTimeout(() => {
        executeSuggest(term)
      }, 150)
    },
    [executeSearch, executeSuggest],
  )

  const setFields = useCallback(
    (fields: string[]) => {
      setState(s => {
        const params = { ...s.params, fields, offset: 0 }
        if (params.term) {
          executeSearch(params)
        }
        return { ...s, params }
      })
    },
    [executeSearch],
  )

  const setBoost = useCallback(
    (field: string, value: number) => {
      setState(s => {
        const boost = { ...s.params.boost }
        if (value === 1) {
          delete boost[field]
        } else {
          boost[field] = value
        }
        const params = { ...s.params, boost }
        if (params.term) executeSearch(params)
        return { ...s, params }
      })
    },
    [executeSearch],
  )

  const setSort = useCallback(
    (field: string, direction: 'asc' | 'desc' | null) => {
      setState(s => {
        const sort = { ...s.params.sort }
        if (direction === null) {
          delete sort[field]
        } else {
          const newSort: Record<string, 'asc' | 'desc'> = {}
          newSort[field] = direction
          Object.assign(newSort, sort)
          return { ...s, params: { ...s.params, sort: newSort } }
        }
        const params = { ...s.params, sort }
        if (params.term) executeSearch(params)
        return { ...s, params }
      })
    },
    [executeSearch],
  )

  const setPage = useCallback(
    (page: number) => {
      setState(s => {
        const params = { ...s.params, offset: page * s.params.limit }
        executeSearch(params)
        return { ...s, params }
      })
    },
    [executeSearch],
  )

  const loadMore = useCallback(() => {
    setState(s => {
      if (!s.results?.cursor) return s
      const params = { ...s.params, searchAfter: s.results.cursor }
      executeSearch(params)
      return { ...s, params }
    })
  }, [executeSearch])

  const setFilter = useCallback(
    (filters: Record<string, unknown>) => {
      setState(s => {
        const params = { ...s.params, filters, offset: 0 }
        if (params.term) executeSearch(params)
        return { ...s, params }
      })
    },
    [executeSearch],
  )

  const updateParam = useCallback(
    <K extends keyof SearchParams>(key: K, value: SearchParams[K]) => {
      setState(s => {
        const params = { ...s.params, [key]: value }
        if (params.term) executeSearch(params)
        return { ...s, params }
      })
    },
    [executeSearch],
  )

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
      if (suggestTimer.current) clearTimeout(suggestTimer.current)
    }
  }, [])

  return {
    ...state,
    setTerm,
    setFields,
    setBoost,
    setSort,
    setPage,
    loadMore,
    setFilter,
    updateParam,
  }
}
