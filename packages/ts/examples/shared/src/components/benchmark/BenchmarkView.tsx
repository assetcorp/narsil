import { useCallback, useState } from 'react'
import type { NarsilBackend } from '../../backend'
import type { AppState, LoadedIndex } from '../../types'
import { Button } from '../ui/button'
import { JudgedBenchmark } from './JudgedBenchmark'
import { ScifactBenchmark } from './ScifactBenchmark'

function benchmarkTargets(state: AppState): LoadedIndex[] {
  return state.indexes.filter(index => index.datasetId === 'scifact' || index.documentCount > 0)
}

function defaultTarget(targets: LoadedIndex[], activeIndexName: string | null): LoadedIndex | null {
  const scifact = targets.find(target => target.datasetId === 'scifact')
  if (scifact) return scifact
  return targets.find(target => target.name === activeIndexName) ?? targets[0] ?? null
}

interface TargetButtonProps {
  target: LoadedIndex
  isActive: boolean
  onSelect: (indexName: string) => void
}

function TargetButton({ target, isActive, onSelect }: TargetButtonProps) {
  const handleClick = useCallback(() => {
    onSelect(target.name)
  }, [onSelect, target.name])

  return (
    <Button
      type="button"
      variant={isActive ? 'default' : 'outline'}
      size="xs"
      className="font-mono text-xs"
      onClick={handleClick}
    >
      {target.name}
    </Button>
  )
}

interface BenchmarkViewProps {
  backend: NarsilBackend
  state: AppState
}

export function BenchmarkView({ backend, state }: BenchmarkViewProps) {
  const [chosenTargetName, setChosenTargetName] = useState<string | null>(null)

  const targets = benchmarkTargets(state)
  const chosen = targets.find(target => target.name === chosenTargetName)
  const target = chosen ?? defaultTarget(targets, state.activeIndexName)

  if (target === null) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-2 font-serif text-3xl tracking-tight">Quality Benchmark</h1>
        <p className="text-sm text-muted-foreground">
          Load a dataset from the Datasets tab to measure retrieval quality. SciFact arrives with expert relevance
          judgments, and you can judge any index built from your own documents with your own questions.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-4">
        <h1 className="mb-1 font-serif text-3xl tracking-tight">Quality Benchmark</h1>
      </div>

      {targets.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {targets.map(entry => (
            <TargetButton
              key={entry.name}
              target={entry}
              isActive={entry.name === target.name}
              onSelect={setChosenTargetName}
            />
          ))}
        </div>
      )}

      {target.datasetId === 'scifact' ? (
        <ScifactBenchmark backend={backend} />
      ) : (
        <JudgedBenchmark key={target.name} backend={backend} index={target} />
      )}
    </div>
  )
}
