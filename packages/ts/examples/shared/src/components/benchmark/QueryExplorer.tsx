import { type ChangeEvent, useCallback, useMemo, useState } from 'react'
import type { QueryMetrics } from '../../lib/metrics'
import { Input } from '../ui/input'

type SortColumn = 'id' | 'ndcg10' | 'precision10' | 'ap' | 'rr'

function QueryRow({
  query,
  isSelected,
  onSelect,
}: {
  query: QueryMetrics
  isSelected: boolean
  onSelect: (query: QueryMetrics) => void
}) {
  const handleClick = useCallback(() => {
    onSelect(query)
  }, [onSelect, query])

  return (
    <tr
      className={`cursor-pointer border-b transition-colors hover:bg-muted/50 ${isSelected ? 'bg-accent' : ''}`}
      onClick={handleClick}
    >
      <td className="px-3 py-1.5 font-mono">{query.queryId}</td>
      <td className="max-w-[200px] truncate px-3 py-1.5">{query.queryText}</td>
      <td className="px-3 py-1.5 text-right font-mono">
        <MetricBadge value={query.ndcg10} />
      </td>
      <td className="px-3 py-1.5 text-right font-mono">
        <MetricBadge value={query.precision10} />
      </td>
      <td className="px-3 py-1.5 text-right font-mono">
        <MetricBadge value={query.ap} />
      </td>
    </tr>
  )
}

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
      .filter(q => {
        if (!filter) return true
        return q.queryText.toLowerCase().includes(lowerFilter) || String(q.queryId).includes(filter)
      })
      .sort((a, b) => {
        const mul = sortAsc ? 1 : -1
        if (sortBy === 'id') return mul * (a.queryId - b.queryId)
        return mul * (a[sortBy] - b[sortBy])
      })
  }, [perQuery, filter, sortBy, sortAsc])

  const toggleSort = useCallback((col: SortColumn) => {
    setSortBy(prev => {
      if (prev === col) {
        setSortAsc(a => !a)
        return prev
      }
      setSortAsc(false)
      return col
    })
  }, [])

  const handleFilterChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setFilter(e.target.value)
  }, [])

  const handleSortId = useCallback(() => toggleSort('id'), [toggleSort])
  const handleSortNdcg = useCallback(() => toggleSort('ndcg10'), [toggleSort])
  const handleSortPrecision = useCallback(() => toggleSort('precision10'), [toggleSort])
  const handleSortAp = useCallback(() => toggleSort('ap'), [toggleSort])

  return (
    <div className="rounded-lg border">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Per-Query Results</h3>
        <Input
          type="text"
          placeholder="Filter queries..."
          value={filter}
          onChange={handleFilterChange}
          className="mt-2 h-7 text-xs"
        />
      </div>
      <div className="max-h-96 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b">
              <th className="cursor-pointer px-3 py-2 text-left font-medium" onClick={handleSortId}>
                # {sortBy === 'id' && (sortAsc ? '\u2191' : '\u2193')}
              </th>
              <th className="px-3 py-2 text-left font-medium">Query</th>
              <th className="cursor-pointer px-3 py-2 text-right font-medium" onClick={handleSortNdcg}>
                nDCG {sortBy === 'ndcg10' && (sortAsc ? '\u2191' : '\u2193')}
              </th>
              <th className="cursor-pointer px-3 py-2 text-right font-medium" onClick={handleSortPrecision}>
                P@10 {sortBy === 'precision10' && (sortAsc ? '\u2191' : '\u2193')}
              </th>
              <th className="cursor-pointer px-3 py-2 text-right font-medium" onClick={handleSortAp}>
                AP {sortBy === 'ap' && (sortAsc ? '\u2191' : '\u2193')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(q => (
              <QueryRow
                key={q.queryId}
                query={q}
                isSelected={selectedQuery?.queryId === q.queryId}
                onSelect={onSelect}
              />
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
