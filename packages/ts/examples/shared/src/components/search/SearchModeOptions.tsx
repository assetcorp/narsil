import type { SearchMode } from '@delali/narsil'
import { type ChangeEvent, useCallback } from 'react'
import type { SearchFormValues } from '../../hooks/use-search-form'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Slider } from '../ui/slider'

type ValueSetter = <K extends keyof SearchFormValues>(key: K, value: SearchFormValues[K]) => void

interface SearchModeOptionsProps {
  values: SearchFormValues
  vectorField: string
  onValueChange: ValueSetter
}

const MODES: Array<{ mode: SearchMode; label: string }> = [
  { mode: 'fulltext', label: 'Full text' },
  { mode: 'vector', label: 'Vector' },
  { mode: 'hybrid', label: 'Hybrid' },
]

const STRATEGIES: Array<{ strategy: SearchFormValues['hybridStrategy']; label: string }> = [
  { strategy: 'rrf', label: 'Reciprocal rank' },
  { strategy: 'linear', label: 'Linear blend' },
]

const MAX_EF_SEARCH = 1_000
const MAX_RRF_K = 1_000

function boundedNumber(raw: string, low: number, high: number): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return low
  return Math.min(high, Math.max(low, parsed))
}

function ModeButton({
  mode,
  label,
  active,
  onValueChange,
}: {
  mode: SearchMode
  label: string
  active: boolean
  onValueChange: ValueSetter
}) {
  const handleClick = useCallback(() => {
    onValueChange('mode', mode)
  }, [onValueChange, mode])

  return (
    <Button variant={active ? 'default' : 'outline'} size="xs" aria-pressed={active} onClick={handleClick}>
      {label}
    </Button>
  )
}

function StrategyButton({
  strategy,
  label,
  active,
  onValueChange,
}: {
  strategy: SearchFormValues['hybridStrategy']
  label: string
  active: boolean
  onValueChange: ValueSetter
}) {
  const handleClick = useCallback(() => {
    onValueChange('hybridStrategy', strategy)
  }, [onValueChange, strategy])

  return (
    <Button variant={active ? 'default' : 'outline'} size="xs" aria-pressed={active} onClick={handleClick}>
      {label}
    </Button>
  )
}

export function SearchModeOptions({ values, vectorField, onValueChange }: SearchModeOptionsProps) {
  const handleSimilarityChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onValueChange('similarity', boundedNumber(event.target.value, 0, 1))
    },
    [onValueChange],
  )

  const handleEfSearchChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onValueChange('efSearch', Math.round(boundedNumber(event.target.value, 0, MAX_EF_SEARCH)))
    },
    [onValueChange],
  )

  const handleRrfKChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onValueChange('rrfK', Math.round(boundedNumber(event.target.value, 1, MAX_RRF_K)))
    },
    [onValueChange],
  )

  const handleAlphaChange = useCallback(
    ([alpha]: number[]) => {
      if (alpha !== undefined) onValueChange('alpha', alpha)
    },
    [onValueChange],
  )

  const usesVectors = values.mode !== 'fulltext'

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-lg border p-4" data-testid="search-mode-options">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">Search mode</span>
        {MODES.map(entry => (
          <ModeButton
            key={entry.mode}
            mode={entry.mode}
            label={entry.label}
            active={values.mode === entry.mode}
            onValueChange={onValueChange}
          />
        ))}
        {usesVectors ? (
          <span className="text-xs text-muted-foreground">
            The index embeds the query text and compares it with <span className="font-mono">{vectorField}</span>.
          </span>
        ) : null}
      </div>

      {usesVectors ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label htmlFor="vector-similarity" className="flex flex-col gap-1.5 text-xs font-medium">
            Similarity floor
            <Input
              id="vector-similarity"
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={values.similarity || ''}
              placeholder="0"
              onChange={handleSimilarityChange}
              className="h-7 text-xs"
            />
          </label>
          <label htmlFor="vector-ef-search" className="flex flex-col gap-1.5 text-xs font-medium">
            efSearch
            <Input
              id="vector-ef-search"
              type="number"
              min="0"
              max={MAX_EF_SEARCH}
              step="10"
              value={values.efSearch || ''}
              placeholder="Engine default"
              onChange={handleEfSearchChange}
              className="h-7 text-xs"
            />
          </label>
          {values.mode === 'hybrid' ? (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-xs font-medium">Fusion</span>
              <div className="flex flex-wrap items-center gap-2">
                {STRATEGIES.map(entry => (
                  <StrategyButton
                    key={entry.strategy}
                    strategy={entry.strategy}
                    label={entry.label}
                    active={values.hybridStrategy === entry.strategy}
                    onValueChange={onValueChange}
                  />
                ))}
              </div>
              {values.hybridStrategy === 'rrf' ? (
                <label htmlFor="hybrid-rrf-k" className="flex items-center gap-2 text-xs">
                  k
                  <Input
                    id="hybrid-rrf-k"
                    type="number"
                    min="1"
                    max={MAX_RRF_K}
                    value={values.rrfK}
                    onChange={handleRrfKChange}
                    className="h-7 w-24 text-xs"
                  />
                </label>
              ) : (
                <div className="flex items-center gap-2 text-xs">
                  <span className="w-28">Vector weight</span>
                  <Slider
                    min={0}
                    max={1}
                    step={0.05}
                    value={[values.alpha]}
                    onValueChange={handleAlphaChange}
                    aria-label="Vector weight"
                    className="flex-1"
                  />
                  <span className="w-8 text-right font-mono">{values.alpha.toFixed(2)}</span>
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
