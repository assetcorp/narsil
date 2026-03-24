import { useState, useMemo } from 'react'
import { Input } from '../ui/input'
import type { QueryMetrics } from '../../lib/metrics'

type SortColumn = 'id' | 'ndcg10' | 'precision10' | 'ap' | 'rr'

interface QueryExplorerProps {
  perQuery: QueryMetrics[]
  selectedQuery: QueryMetrics | null
  onSelect: (query: QueryMetrics | null) => void
}

export function QueryExplorer({ perQuery, selectedQuery, onSelect }: QueryExplorerProps) {
  const [filter, setFilter] = useState('')
  const [sortBy, setSortBy] = useState<SortColumn>('ndcg10')
  const [sortAsc, setSortAsc] = useState(false)

  const filtered = useMemo(() => {
    const lowerFilter = filter.toLowerCase()
    return perQuery
      .filter((q) => {
        if (!filter) return true
        return (
          q.queryText.toLowerCase().includes(lowerFilter) ||
          String(q.queryId).includes(filter)
        )
      })
      .sort((a, b) => {
        const mul = sortAsc ? 1 : -1
        if (sortBy === 'id') return mul * (a.queryId - b.queryId)
        return mul * (a[sortBy] - b[sortBy])
      })
  }, [perQuery, filter, sortBy, sortAsc])

  function toggleSort(col: typeof sortBy) {
    if (sortBy === col) {
      setSortAsc(!sortAsc)
    } else {
      setSortBy(col)
      setSortAsc(false)
    }
  }

  return (
    <div className="rounded-lg border">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Per-Query Results</h3>
        <Input
          type="text"
          placeholder="Filter queries..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="mt-2 h-7 text-xs"
        />
      </div>
      <div className="max-h-96 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b">
              <th className="cursor-pointer px-3 py-2 text-left font-medium" onClick={() => toggleSort('id')}>
                # {sortBy === 'id' && (sortAsc ? '\u2191' : '\u2193')}
              </th>
              <th className="px-3 py-2 text-left font-medium">Query</th>
              <th className="cursor-pointer px-3 py-2 text-right font-medium" onClick={() => toggleSort('ndcg10')}>
                nDCG {sortBy === 'ndcg10' && (sortAsc ? '\u2191' : '\u2193')}
              </th>
              <th className="cursor-pointer px-3 py-2 text-right font-medium" onClick={() => toggleSort('precision10')}>
                P@10 {sortBy === 'precision10' && (sortAsc ? '\u2191' : '\u2193')}
              </th>
              <th className="cursor-pointer px-3 py-2 text-right font-medium" onClick={() => toggleSort('ap')}>
                AP {sortBy === 'ap' && (sortAsc ? '\u2191' : '\u2193')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((q) => (
              <tr
                key={q.queryId}
                className={`cursor-pointer border-b transition-colors hover:bg-muted/50 ${selectedQuery?.queryId === q.queryId ? 'bg-accent' : ''}`}
                onClick={() => onSelect(q)}
              >
                <td className="px-3 py-1.5 font-mono">{q.queryId}</td>
                <td className="max-w-[200px] truncate px-3 py-1.5">{q.queryText}</td>
                <td className="px-3 py-1.5 text-right font-mono">
                  <MetricBadge value={q.ndcg10} />
                </td>
                <td className="px-3 py-1.5 text-right font-mono">
                  <MetricBadge value={q.precision10} />
                </td>
                <td className="px-3 py-1.5 text-right font-mono">
                  <MetricBadge value={q.ap} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function MetricBadge({ value }: { value: number }) {
  const color =
    value >= 0.7
      ? 'text-green-600 dark:text-green-400'
      : value >= 0.4
        ? 'text-yellow-600 dark:text-yellow-400'
        : 'text-red-600 dark:text-red-400'

  return <span className={color}>{value.toFixed(3)}</span>
}
