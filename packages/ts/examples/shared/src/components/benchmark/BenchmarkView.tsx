import type { Dispatch } from 'react'
import type { NarsilBackend } from '../../backend'
import type { AppAction, AppState, LoadedIndex } from '../../types'
import { IndexSelector } from '../IndexSelector'
import { JudgedBenchmark } from './JudgedBenchmark'
import { ScifactBenchmark } from './ScifactBenchmark'

function benchmarkTargets(state: AppState): LoadedIndex[] {
  return state.indexes.filter(index => index.datasetId === 'scifact' || index.documentCount > 0)
}

interface BenchmarkViewProps {
  backend: NarsilBackend
  state: AppState
  dispatch: Dispatch<AppAction>
}

export function BenchmarkView({ backend, state, dispatch }: BenchmarkViewProps) {
  const targets = benchmarkTargets(state)
  const target = targets.find(entry => entry.name === state.activeIndexName) ?? targets[0] ?? null

  if (target === null) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Quality Benchmark</h1>
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
        <h1 className="mb-1 text-3xl font-bold tracking-tight">Quality Benchmark</h1>
      </div>

      <IndexSelector indexes={targets} activeIndexName={target.name} dispatch={dispatch} />

      {target.datasetId === 'scifact' ? (
        <ScifactBenchmark backend={backend} />
      ) : (
        <JudgedBenchmark key={target.name} backend={backend} index={target} />
      )}
    </div>
  )
}
