import type { PreflightResult, QueryParams } from '@delali/narsil'
import { Loader2 } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useEngineActions } from '../../engine-actions'
import { Button } from '../ui/button'

interface MatchCountProps {
  indexName: string
  params: QueryParams
}

type CountOutcome =
  | { kind: 'counting' }
  | { kind: 'counted'; result: PreflightResult }
  | { kind: 'failed'; message: string }

interface CountState {
  indexName: string
  params: QueryParams
  outcome: CountOutcome
}

export function MatchCount({ indexName, params }: MatchCountProps) {
  const actions = useEngineActions()
  const [state, setState] = useState<CountState | null>(null)
  const outcome = state !== null && state.indexName === indexName && state.params === params ? state.outcome : null

  const handleCount = useCallback(async () => {
    setState({ indexName, params, outcome: { kind: 'counting' } })
    try {
      const result = await actions.preflight(indexName, params)
      setState({ indexName, params, outcome: { kind: 'counted', result } })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setState({ indexName, params, outcome: { kind: 'failed', message } })
    }
  }, [actions, indexName, params])

  return (
    <div className="flex max-w-48 shrink-0 flex-col items-end gap-2 text-right text-xs text-muted-foreground sm:max-w-xs">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9 text-xs"
        onClick={handleCount}
        disabled={outcome?.kind === 'counting'}
      >
        {outcome?.kind === 'counting' ? <Loader2 className="size-3 animate-spin" /> : null}
        Count matches first
      </Button>
      {outcome?.kind === 'counted' ? (
        <span data-testid="preflight-count">
          {outcome.result.countExact ? '' : 'At least '}
          {outcome.result.count.toLocaleString()} match{outcome.result.count === 1 ? '' : 'es'}, counted in{' '}
          {outcome.result.elapsed.toFixed(1)}ms without building any hit
          {outcome.result.analysisStale === true ? '. The index terms come from an older analysis.' : ''}
        </span>
      ) : null}
      {outcome?.kind === 'failed' ? <span className="text-destructive">{outcome.message}</span> : null}
    </div>
  )
}
