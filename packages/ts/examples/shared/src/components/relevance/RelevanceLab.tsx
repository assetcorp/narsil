import { type Dispatch } from 'react'
import type { NarsilBackend } from '../../backend'
import type { AppState, AppAction } from '../../types'
import { useRelevance } from '../../hooks/use-relevance'
import { ScoreBreakdown } from './ScoreBreakdown'
import { TuningPanel } from './TuningPanel'
import { RankComparison } from './RankComparison'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Search, Loader2 } from 'lucide-react'

interface RelevanceLabProps {
  backend: NarsilBackend
  state: AppState
  dispatch: Dispatch<AppAction>
}

function getSearchableFields(state: AppState): string[] {
  const activeIndex = state.indexes.find((i) => i.name === state.activeIndexName)
  if (!activeIndex) return []
  switch (activeIndex.datasetId) {
    case 'tmdb': return ['title', 'overview', 'tagline']
    case 'wikipedia': return ['title', 'text']
    case 'cranfield': return ['title', 'body']
    default: return []
  }
}

export function RelevanceLab({ backend, state, dispatch }: RelevanceLabProps) {
  const indexName = state.activeIndexName
  const fields = getSearchableFields(state)
  const relevance = useRelevance(backend, indexName)

  if (!indexName) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-2 font-serif text-3xl tracking-tight">Relevance Lab</h1>
        <p className="text-sm text-muted-foreground">
          Load a dataset from the Datasets tab to explore BM25 scoring and tuning.
        </p>
      </div>
    )
  }

  const activeIndex = state.indexes.find((i) => i.name === indexName)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="mb-1 font-serif text-3xl tracking-tight">Relevance Lab</h1>
        {activeIndex && (
          <p className="text-sm text-muted-foreground">
            BM25 scoring for <span className="font-mono font-medium text-foreground">{activeIndex.name}</span>
          </p>
        )}
      </div>

      {state.indexes.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {state.indexes.map((idx) => (
            <Button
              key={idx.name}
              type="button"
              variant={idx.name === indexName ? 'default' : 'outline'}
              size="xs"
              className="font-mono text-xs"
              onClick={() => dispatch({ type: 'SET_ACTIVE_INDEX', payload: idx.name })}
            >
              {idx.name}
            </Button>
          ))}
        </div>
      )}

      <div className="relative mb-6">
        <Search className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Enter a query to analyze scoring..."
          value={relevance.term}
          onChange={(e) => relevance.setTerm(e.target.value)}
          className="pl-10 pr-10"
        />
        {relevance.isLoading && (
          <Loader2 className="pointer-events-none absolute top-1/2 right-3 z-10 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
        {relevance.elapsed !== null && (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {relevance.count} results in {relevance.elapsed.toFixed(1)}ms
          </p>
        )}
      </div>

      {relevance.error && (
        <div className="mb-6 rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
          {relevance.error}
        </div>
      )}

      {relevance.originalHits.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
          <div className="flex flex-col gap-4">
            <RankComparison recomputedHits={relevance.recomputedHits} />
            <ScoreBreakdown recomputedHits={relevance.recomputedHits} fields={fields} />
          </div>
          <aside>
            <TuningPanel
              config={relevance.config}
              fields={fields}
              onK1Change={relevance.setK1}
              onBChange={relevance.setB}
              onFieldBoostChange={relevance.setFieldBoost}
              onReset={relevance.resetConfig}
            />
          </aside>
        </div>
      )}
    </div>
  )
}
