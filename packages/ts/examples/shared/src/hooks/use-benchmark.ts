import { useCallback, useRef, useState } from 'react'
import { QUERY_CONCURRENCY, runPooled } from '../lib/concurrency'
import type { BenchmarkResult, QueryMetrics, RelevanceMap } from '../lib/metrics'
import { averagePrecision, ndcgAtK, precisionAtK, reciprocalRank } from '../lib/metrics'
import type { QueryRunner } from '../query-runner'

const SCIFACT_INDEX = 'scifact'
const RESULT_DEPTH = 100

interface ScifactQuery {
  id: number
  text: string
}

interface ScifactQrel {
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

const IDLE_STATE: BenchmarkState = {
  isRunning: false,
  progress: 0,
  totalQueries: 0,
  result: null,
  selectedQuery: null,
  error: null,
}

function aggregate(measured: ReadonlyArray<QueryMetrics | undefined>): BenchmarkResult {
  const perQuery: QueryMetrics[] = []
  let sumNdcg10 = 0
  let sumPrecision10 = 0
  let sumAp = 0
  let sumRr = 0
  for (const metrics of measured) {
    if (metrics === undefined) continue
    perQuery.push(metrics)
    sumNdcg10 += metrics.ndcg10
    sumPrecision10 += metrics.precision10
    sumAp += metrics.ap
    sumRr += metrics.rr
  }
  const evaluated = perQuery.length || 1
  return {
    aggregate: {
      meanNdcg10: sumNdcg10 / evaluated,
      meanPrecision10: sumPrecision10 / evaluated,
      map: sumAp / evaluated,
      mrr: sumRr / evaluated,
      queriesEvaluated: perQuery.length,
    },
    perQuery,
  }
}

async function readScifactJudgments(): Promise<{ queries: ScifactQuery[]; qrelsByQuery: Map<number, RelevanceMap> }> {
  const [queriesResponse, qrelsResponse] = await Promise.all([
    fetch('/data/processed/scifact/scifact-queries.json'),
    fetch('/data/processed/scifact/scifact-qrels.json'),
  ])
  if (!queriesResponse.ok || !qrelsResponse.ok) {
    throw new Error('The SciFact query and judgment files could not be read. Load the SciFact dataset first.')
  }

  const queries = (await queriesResponse.json()) as ScifactQuery[]
  const qrels = (await qrelsResponse.json()) as ScifactQrel[]
  const qrelsByQuery = new Map<number, RelevanceMap>()
  for (const qrel of qrels) {
    let judgments = qrelsByQuery.get(qrel.queryId)
    if (!judgments) {
      judgments = new Map()
      qrelsByQuery.set(qrel.queryId, judgments)
    }
    judgments.set(String(qrel.docId), qrel.relevance)
  }
  return { queries, qrelsByQuery }
}

/**
 * Measures retrieval quality over the SciFact claims against their expert
 * judgments. The searches run through the injected runner, several at a time,
 * and the figures update as each one answers.
 */
export function useBenchmark(runQuery: QueryRunner) {
  const [state, setState] = useState<BenchmarkState>(IDLE_STATE)
  const abortRef = useRef(false)

  const run = useCallback(async () => {
    abortRef.current = false
    setState({ ...IDLE_STATE, isRunning: true })

    try {
      const { queries, qrelsByQuery } = await readScifactJudgments()
      setState(current => ({ ...current, totalQueries: queries.length }))

      const measured: Array<QueryMetrics | undefined> = new Array(queries.length)
      let answered = 0
      await runPooled(
        queries,
        QUERY_CONCURRENCY,
        async (query, position) => {
          const result = await runQuery(SCIFACT_INDEX, { term: query.text, limit: RESULT_DEPTH })
          const judgments = qrelsByQuery.get(query.id) ?? new Map<string, number>()
          let totalRelevant = 0
          for (const relevance of judgments.values()) {
            if (relevance > 0) totalRelevant++
          }
          const resultIds = result.hits.map(hit => String(hit.document.id ?? hit.id))
          measured[position] = {
            queryId: query.id,
            queryText: query.text,
            ndcg10: ndcgAtK(resultIds, judgments, 10),
            precision10: precisionAtK(resultIds, judgments, 10),
            ap: averagePrecision(resultIds, judgments, totalRelevant),
            rr: reciprocalRank(resultIds, judgments),
            resultIds,
            judgments,
          }
          answered++
          setState(current => ({ ...current, progress: answered, result: aggregate(measured) }))
        },
        () => abortRef.current,
      )

      setState(current => ({ ...current, isRunning: false, result: aggregate(measured) }))
    } catch (err) {
      setState(current => ({
        ...current,
        isRunning: false,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }, [runQuery])

  const abort = useCallback(() => {
    abortRef.current = true
  }, [])

  const selectQuery = useCallback((query: QueryMetrics | null) => {
    setState(current => ({ ...current, selectedQuery: query }))
  }, [])

  return { ...state, run, abort, selectQuery }
}
