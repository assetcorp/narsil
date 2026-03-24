import { Badge } from '../ui/badge'
import type { RecomputedHit } from '../../scoring'

interface RankComparisonProps {
  recomputedHits: RecomputedHit[]
}

export function RankComparison({ recomputedHits }: RankComparisonProps) {
  if (recomputedHits.length === 0) return null

  const hasChanges = recomputedHits.some((h) => h.originalRank !== h.recomputedRank)

  return (
    <div className="rounded-lg border">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Rank Comparison</h3>
        <p className="text-xs text-muted-foreground">
          {hasChanges ? 'Rankings changed with tuned parameters' : 'No rank changes with current parameters'}
        </p>
      </div>
      <div className="max-h-64 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium">Document</th>
              <th className="px-3 py-2 text-right font-medium">Original</th>
              <th className="px-3 py-2 text-right font-medium">Tuned</th>
              <th className="px-3 py-2 text-right font-medium">Score</th>
              <th className="px-3 py-2 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {recomputedHits.slice(0, 20).map((item) => {
              const doc = item.hit.document
              const title = String(doc.title ?? doc.id ?? item.hit.id)
              const delta = item.originalRank - item.recomputedRank

              return (
                <tr key={item.hit.id} className="border-b last:border-b-0">
                  <td className="max-w-[200px] truncate px-3 py-1.5">{title}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                    #{item.originalRank}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">
                    #{item.recomputedRank}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">
                    {item.recomputedScore.toFixed(3)}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {delta !== 0 && (
                      <Badge
                        variant={delta > 0 ? 'default' : 'destructive'}
                        className="text-[10px]"
                      >
                        {delta > 0 ? `\u2191${delta}` : `\u2193${Math.abs(delta)}`}
                      </Badge>
                    )}
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
