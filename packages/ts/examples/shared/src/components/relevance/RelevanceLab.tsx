import type { QueryResult } from '@delali/narsil'
import { Loader2, Search } from 'lucide-react'
import { type ChangeEvent, useCallback, useMemo, useState } from 'react'
import type { IndexSchemaView } from '../../hooks/use-index-schema'
import { type BM25Config, computeFieldAverages, DEFAULT_BM25_CONFIG, recomputeScores } from '../../scoring'
import { useActiveIndex, useIndexWorkspace } from '../../workspace'
import { IndexSelector } from '../IndexSelector'
import { Input } from '../ui/input'
import { RankComparison } from './RankComparison'
import { ScoreBreakdown } from './ScoreBreakdown'
import { TuningPanel } from './TuningPanel'

export interface RelevanceLabProps {
  schema: IndexSchemaView
  term: string
  onTermChange: (term: string) => void
  result: QueryResult | undefined
  isLoading: boolean
  error: Error | undefined
}

export function RelevanceLab({ schema, term, onTermChange, result, isLoading, error }: RelevanceLabProps) {
  const { activeIndexName } = useIndexWorkspace()
  const activeIndex = useActiveIndex()
  const fields = schema.searchablePaths
  const [config, setConfig] = useState<BM25Config>(DEFAULT_BM25_CONFIG)

  const hits = result?.hits
  const recomputedHits = useMemo(() => {
    if (hits === undefined || hits.length === 0) return []
    return recomputeScores(hits, config, computeFieldAverages(hits))
  }, [hits, config])

  const handleTermChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onTermChange(event.target.value)
    },
    [onTermChange],
  )

  const handleK1Change = useCallback((k1: number) => {
    setConfig(current => ({ ...current, k1 }))
  }, [])

  const handleBChange = useCallback((b: number) => {
    setConfig(current => ({ ...current, b }))
  }, [])

  const handleFieldBoostChange = useCallback((field: string, boost: number) => {
    setConfig(current => {
      const fieldBoosts = { ...current.fieldBoosts }
      if (boost === 1) {
        delete fieldBoosts[field]
      } else {
        fieldBoosts[field] = boost
      }
      return { ...current, fieldBoosts }
    })
  }, [])

  const handleReset = useCallback(() => {
    setConfig({ ...DEFAULT_BM25_CONFIG, fieldBoosts: {} })
  }, [])

  if (activeIndexName === null) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Relevance Lab</h1>
        <p className="text-sm text-muted-foreground">
          Load a dataset from the Datasets tab to explore BM25 scoring and tuning.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="mb-1 text-3xl font-bold tracking-tight">Relevance Lab</h1>
        {activeIndex ? (
          <p className="text-sm text-muted-foreground">
            BM25 scoring for <span className="font-mono font-medium text-foreground">{activeIndex.name}</span>
          </p>
        ) : null}
      </div>

      <IndexSelector />

      <div className="mb-6">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Enter a query to analyze scoring..."
            value={term}
            onChange={handleTermChange}
            className="pl-10 pr-10 focus-visible:ring-1"
          />
          {isLoading ? (
            <Loader2 className="pointer-events-none absolute top-1/2 right-3 z-10 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        {result === undefined ? null : (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {result.count} results in {result.elapsed.toFixed(1)}ms
          </p>
        )}
      </div>

      {error === undefined ? null : (
        <div className="mb-6 rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
          {error.message}
        </div>
      )}

      {recomputedHits.length > 0 ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
          <div className="flex flex-col gap-4">
            <RankComparison recomputedHits={recomputedHits} />
            <ScoreBreakdown recomputedHits={recomputedHits} fields={fields} />
          </div>
          <aside>
            <TuningPanel
              config={config}
              fields={fields}
              onK1Change={handleK1Change}
              onBChange={handleBChange}
              onFieldBoostChange={handleFieldBoostChange}
              onReset={handleReset}
            />
          </aside>
        </div>
      ) : null}
    </div>
  )
}
