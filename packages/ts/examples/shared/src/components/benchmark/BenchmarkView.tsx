import type { NarsilBackend } from '../../backend'
import { useBenchmark } from '../../hooks/use-benchmark'
import type { AppState } from '../../types'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import { AggregateTable } from './AggregateTable'
import { QueryExplorer } from './QueryExplorer'
import { SideBySide } from './SideBySide'

interface BenchmarkViewProps {
  backend: NarsilBackend
  state: AppState
}

export function BenchmarkView({ backend, state }: BenchmarkViewProps) {
  const benchmark = useBenchmark(backend)
  const cranfieldLoaded = state.cranfieldLoaded

  if (!cranfieldLoaded) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-2 font-serif text-3xl tracking-tight">Quality Benchmark</h1>
        <p className="text-sm text-muted-foreground">
          Load the Cranfield collection from the Datasets tab to run retrieval quality benchmarks.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="mb-1 font-serif text-3xl tracking-tight">Quality Benchmark</h1>
          <p className="text-sm text-muted-foreground">
            Evaluates retrieval quality across 225 Cranfield queries with expert relevance judgments.
          </p>
        </div>
        <div className="flex gap-2">
          {benchmark.isRunning ? (
            <Button variant="destructive" size="sm" onClick={benchmark.abort}>
              Abort
            </Button>
          ) : (
            <Button size="sm" onClick={benchmark.run}>
              {benchmark.result ? 'Re-run' : 'Run Benchmark'}
            </Button>
          )}
        </div>
      </div>

      {benchmark.isRunning && (
        <div className="mb-6">
          <Progress value={(benchmark.progress / benchmark.totalQueries) * 100} />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Evaluating query {benchmark.progress} of {benchmark.totalQueries}
          </p>
        </div>
      )}

      {benchmark.error && (
        <div className="mb-6 rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
          {benchmark.error}
        </div>
      )}

      {benchmark.result && (
        <div className="flex flex-col gap-6">
          <AggregateTable metrics={benchmark.result.aggregate} />

          <div className="grid gap-6 lg:grid-cols-2">
            <QueryExplorer
              perQuery={benchmark.result.perQuery}
              selectedQuery={benchmark.selectedQuery}
              onSelect={benchmark.selectQuery}
            />
            {benchmark.selectedQuery && <SideBySide query={benchmark.selectedQuery} backend={backend} />}
          </div>
        </div>
      )}
    </div>
  )
}
