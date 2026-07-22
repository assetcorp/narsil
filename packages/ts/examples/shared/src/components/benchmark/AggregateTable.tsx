import type { AggregateMetrics } from '../../lib/metrics'
import { cn } from '../../lib/utils'

interface AggregateTableProps {
  metrics: AggregateMetrics
}

export function AggregateTable({ metrics }: AggregateTableProps) {
  const cells = [
    { label: 'nDCG@10', value: metrics.meanNdcg10 },
    { label: 'P@10', value: metrics.meanPrecision10 },
    { label: 'MAP', value: metrics.map },
    { label: 'MRR', value: metrics.mrr },
  ]

  return (
    <div className="rounded-lg border">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Aggregate Metrics</h3>
        <p className="text-xs text-muted-foreground">{metrics.queriesEvaluated} queries evaluated</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4">
        {cells.map((cell, i) => (
          <div
            key={cell.label}
            className={cn(
              'p-4 text-center',
              i % 2 === 1 && 'border-l',
              i >= 2 && 'border-t sm:border-t-0',
              i === 2 && 'sm:border-l',
            )}
          >
            <span className="block font-mono text-2xl font-bold">{cell.value.toFixed(4)}</span>
            <span className="text-xs text-muted-foreground">{cell.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
