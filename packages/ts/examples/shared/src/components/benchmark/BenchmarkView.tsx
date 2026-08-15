import { useMemo } from 'react'
import { useIndexWorkspace } from '../../workspace'
import { IndexSelector } from '../IndexSelector'
import { JudgedBenchmark } from './JudgedBenchmark'
import { ScifactBenchmark } from './ScifactBenchmark'

export function BenchmarkView() {
  const { indexes, activeIndexName } = useIndexWorkspace()
  const targets = useMemo(
    () => indexes.filter(index => index.datasetId === 'scifact' || index.documentCount > 0),
    [indexes],
  )
  const target = targets.find(entry => entry.name === activeIndexName) ?? targets[0] ?? null

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

      <IndexSelector indexes={targets} />

      {target.datasetId === 'scifact' ? <ScifactBenchmark /> : <JudgedBenchmark key={target.name} index={target} />}
    </div>
  )
}
