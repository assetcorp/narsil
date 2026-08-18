import { useBenchmark } from '../../hooks/use-benchmark'
import { useQueryRunner } from '../../query-runner'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import { AggregateTable } from './AggregateTable'
import { QueryExplorer } from './QueryExplorer'
import { SideBySide } from './SideBySide'

export function ScifactBenchmark() {
  const runQuery = useQueryRunner()
  const benchmark = useBenchmark(runQuery)

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Evaluates retrieval quality across 300 SciFact claim queries with expert relevance judgments.
        </p>
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
            {benchmark.selectedQuery && <SideBySide query={benchmark.selectedQuery} />}
          </div>
        </div>
      )}
    </>
  )
}
