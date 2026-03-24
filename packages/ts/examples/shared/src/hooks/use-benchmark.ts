import { useState, useCallback, useRef } from 'react'
import type { NarsilBackend } from '../backend'
import {
  ndcgAtK,
  precisionAtK,
  averagePrecision,
  reciprocalRank,
} from '../lib/metrics'
import type { RelevanceMap, QueryMetrics, BenchmarkResult } from '../lib/metrics'

interface CranfieldQuery {
  id: number
  text: string
}

interface CranfieldQrel {
  queryId: number
  docId: number
  relevance: number
}

export interface BenchmarkState {
  isRunning: boolean
  progress: number
  totalQueries: number
  result: BenchmarkResult | null
  selectedQuery: QueryMetrics | null
  error: string | null
}

export function useBenchmark(backend: NarsilBackend) {
  const [state, setState] = useState<BenchmarkState>({
    isRunning: false,
    progress: 0,
    totalQueries: 0,
    result: null,
    selectedQuery: null,
    error: null,
  })

  const abortRef = useRef(false)

  const run = useCallback(async () => {
    abortRef.current = false
    setState({
      isRunning: true,
      progress: 0,
      totalQueries: 0,
      result: null,
      selectedQuery: null,
      error: null,
    })

    try {
      const [queriesResp, qrelsResp] = await Promise.all([
        fetch('/data/processed/cranfield/cranfield-queries.json'),
        fetch('/data/processed/cranfield/cranfield-qrels.json'),
      ])

      if (!queriesResp.ok || !qrelsResp.ok) {
        throw new Error('Failed to fetch Cranfield data files. Ensure cranfield data is available.')
      }

      const queries: CranfieldQuery[] = await queriesResp.json()
      const qrels: CranfieldQrel[] = await qrelsResp.json()

      const qrelsByQuery = new Map<number, RelevanceMap>()
      for (const qrel of qrels) {
        let map = qrelsByQuery.get(qrel.queryId)
        if (!map) {
          map = new Map()
          qrelsByQuery.set(qrel.queryId, map)
        }
        map.set(String(qrel.docId), qrel.relevance)
      }

      setState((s) => ({ ...s, totalQueries: queries.length }))

      const perQuery: QueryMetrics[] = []
      let sumNdcg10 = 0
      let sumPrecision10 = 0
      let sumAp = 0
      let sumRr = 0

      for (let i = 0; i < queries.length; i++) {
        if (abortRef.current) break

        const query = queries[i]
        const judgments = qrelsByQuery.get(query.id) ?? new Map<string, number>()
        const totalRelevant = Array.from(judgments.values()).filter((r) => r > 0).length

        const response = await backend.query({
          indexName: 'cranfield',
          term: query.text,
          limit: 100,
        })

        const resultIds = response.hits.map((h) => String(h.document.id ?? h.id))

        const ndcg10 = ndcgAtK(resultIds, judgments, 10)
        const precision10 = precisionAtK(resultIds, judgments, 10)
        const ap = averagePrecision(resultIds, judgments, totalRelevant)
        const rr = reciprocalRank(resultIds, judgments)

        sumNdcg10 += ndcg10
        sumPrecision10 += precision10
        sumAp += ap
        sumRr += rr

        perQuery.push({
          queryId: query.id,
          queryText: query.text,
          ndcg10,
          precision10,
          ap,
          rr,
          resultIds,
          judgments,
        })

        setState((s) => ({
          ...s,
          progress: i + 1,
          result: {
            aggregate: {
              meanNdcg10: sumNdcg10 / (i + 1),
              meanPrecision10: sumPrecision10 / (i + 1),
              map: sumAp / (i + 1),
              mrr: sumRr / (i + 1),
              queriesEvaluated: i + 1,
            },
            perQuery: [...perQuery],
          },
        }))
      }

      const n = perQuery.length
      setState((s) => ({
        ...s,
        isRunning: false,
        result: {
          aggregate: {
            meanNdcg10: n > 0 ? sumNdcg10 / n : 0,
            meanPrecision10: n > 0 ? sumPrecision10 / n : 0,
            map: n > 0 ? sumAp / n : 0,
            mrr: n > 0 ? sumRr / n : 0,
            queriesEvaluated: n,
          },
          perQuery,
        },
      }))
    } catch (err) {
      setState((s) => ({
        ...s,
        isRunning: false,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }, [backend])

  const abort = useCallback(() => {
    abortRef.current = true
  }, [])

  const selectQuery = useCallback((query: QueryMetrics | null) => {
    setState((s) => ({ ...s, selectedQuery: query }))
  }, [])

  return { ...state, run, abort, selectQuery }
}
