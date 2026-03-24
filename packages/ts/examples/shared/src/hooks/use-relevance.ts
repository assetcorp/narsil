import { useState, useCallback, useRef } from 'react'
import type { NarsilBackend, QueryHit } from '../backend'
import { recomputeScores, computeFieldAverages, DEFAULT_BM25_CONFIG } from '../scoring'
import type { BM25Config, RecomputedHit } from '../scoring'

export interface RelevanceState {
  term: string
  originalHits: QueryHit[]
  recomputedHits: RecomputedHit[]
  config: BM25Config
  isLoading: boolean
  error: string | null
  elapsed: number | null
  count: number
}

export function useRelevance(backend: NarsilBackend, indexName: string | null) {
  const [state, setState] = useState<RelevanceState>({
    term: '',
    originalHits: [],
    recomputedHits: [],
    config: { ...DEFAULT_BM25_CONFIG },
    isLoading: false,
    error: null,
    elapsed: null,
    count: 0,
  })

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hitsRef = useRef<QueryHit[]>([])

  const doRecompute = useCallback((hits: QueryHit[], config: BM25Config): RecomputedHit[] => {
    if (hits.length === 0) return []
    const averages = computeFieldAverages(hits)
    return recomputeScores(hits, config, averages)
  }, [])

  const executeSearch = useCallback(
    async (term: string) => {
      if (!indexName || !term.trim()) {
        setState((s) => ({
          ...s,
          originalHits: [],
          recomputedHits: [],
          isLoading: false,
          error: null,
          elapsed: null,
          count: 0,
        }))
        hitsRef.current = []
        return
      }

      setState((s) => ({ ...s, isLoading: true, error: null }))

      try {
        const result = await backend.query({
          indexName,
          term,
          limit: 50,
          includeScoreComponents: true,
        })

        hitsRef.current = result.hits
        const recomputedHits = doRecompute(result.hits, state.config)

        setState((s) => ({
          ...s,
          originalHits: result.hits,
          recomputedHits,
          isLoading: false,
          elapsed: result.elapsed,
          count: result.count,
        }))
      } catch (err) {
        setState((s) => ({
          ...s,
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    },
    [backend, indexName, state.config, doRecompute]
  )

  const setTerm = useCallback(
    (term: string) => {
      setState((s) => ({ ...s, term }))
      if (searchTimer.current) clearTimeout(searchTimer.current)
      searchTimer.current = setTimeout(() => executeSearch(term), 300)
    },
    [executeSearch]
  )

  const setK1 = useCallback(
    (k1: number) => {
      setState((s) => {
        const config = { ...s.config, k1 }
        const recomputedHits = doRecompute(hitsRef.current, config)
        return { ...s, config, recomputedHits }
      })
    },
    [doRecompute]
  )

  const setB = useCallback(
    (b: number) => {
      setState((s) => {
        const config = { ...s.config, b }
        const recomputedHits = doRecompute(hitsRef.current, config)
        return { ...s, config, recomputedHits }
      })
    },
    [doRecompute]
  )

  const setFieldBoost = useCallback(
    (field: string, boost: number) => {
      setState((s) => {
        const fieldBoosts = { ...s.config.fieldBoosts }
        if (boost === 1) {
          delete fieldBoosts[field]
        } else {
          fieldBoosts[field] = boost
        }
        const config = { ...s.config, fieldBoosts }
        const recomputedHits = doRecompute(hitsRef.current, config)
        return { ...s, config, recomputedHits }
      })
    },
    [doRecompute]
  )

  const resetConfig = useCallback(() => {
    setState((s) => {
      const config = { ...DEFAULT_BM25_CONFIG, fieldBoosts: {} }
      const recomputedHits = doRecompute(hitsRef.current, config)
      return { ...s, config, recomputedHits }
    })
  }, [doRecompute])

  return {
    ...state,
    setTerm,
    setK1,
    setB,
    setFieldBoost,
    resetConfig,
  }
}
