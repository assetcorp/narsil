import type { Hit } from '@delali/narsil'
import { Badge } from '../ui/badge'

interface RankComparisonProps {
  baselineHits: Hit[]
  tunedHits: Hit[]
}

const ROWS_SHOWN = 20

function titleOf(hit: Hit): string {
  const document = hit.document as Record<string, unknown> | undefined
  const title = document?.title ?? document?.name ?? hit.id
  return String(title)
}

export function RankComparison({ baselineHits, tunedHits }: RankComparisonProps) {
  if (tunedHits.length === 0) return null

  const baselineRanks = new Map(baselineHits.map((hit, index) => [hit.id, index + 1]))
  const rows = tunedHits.slice(0, ROWS_SHOWN).map((hit, index) => ({
    hit,
    tunedRank: index + 1,
    originalRank: baselineRanks.get(hit.id) ?? null,
  }))
  const hasChanges = rows.some(row => row.originalRank !== row.tunedRank)

  return (
    <div className="min-w-0 rounded-lg border" data-testid="rank-comparison">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Rank Comparison</h3>
        <p className="text-xs text-muted-foreground">
          {hasChanges
            ? 'The engine ranked this query differently under the tuned settings'
            : 'The tuned settings leave the ranking unchanged'}
        </p>
      </div>
      <div className="max-h-64 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium">Document</th>
              <th className="px-3 py-2 text-right font-medium">Default</th>
              <th className="px-3 py-2 text-right font-medium">Tuned</th>
              <th className="px-3 py-2 text-right font-medium">Score</th>
              <th className="px-3 py-2 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const delta = row.originalRank === null ? null : row.originalRank - row.tunedRank
              return (
                <tr
                  key={row.hit.id}
                  className="border-b last:border-b-0"
                  data-testid="rank-row"
                  data-doc-id={row.hit.id}
                >
                  <td className="max-w-50 truncate px-3 py-1.5">{titleOf(row.hit)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                    {row.originalRank === null ? 'new' : `#${row.originalRank}`}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">#{row.tunedRank}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{(row.hit.score ?? 0).toFixed(3)}</td>
                  <td className="px-3 py-1.5 text-right">
                    {delta !== null && delta !== 0 ? (
                      <Badge variant={delta > 0 ? 'default' : 'destructive'} className="text-[10px]">
                        {delta > 0 ? `↑${delta}` : `↓${Math.abs(delta)}`}
                      </Badge>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
