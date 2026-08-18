import type { Hit } from '@delali/narsil'
import { useEffect, useState } from 'react'
import type { QueryMetrics } from '../../lib/metrics'
import { useQueryRunner } from '../../query-runner'
import { Badge } from '../ui/badge'

interface SideBySideProps {
  query: QueryMetrics
}

const GRADE_LABELS = ['Not relevant', 'Relevant']
const GRADE_COLORS = ['bg-destructive/12 text-foreground', 'bg-chart-2/15 text-foreground']

export function SideBySide({ query }: SideBySideProps) {
  const runQuery = useQueryRunner()
  const [narsilHits, setNarsilHits] = useState<Hit[]>([])

  useEffect(() => {
    const controller = new AbortController()
    runQuery('scifact', { term: query.queryText, limit: 10 }, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) setNarsilHits(result.hits)
      })
      .catch(() => undefined)
    return () => {
      controller.abort()
    }
  }, [runQuery, query.queryText])

  const expertRanking = Array.from(query.judgments.entries())
    .filter(([, rel]) => rel > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)

  return (
    <div className="min-w-0 rounded-lg border">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Query #{query.queryId}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{query.queryText}</p>
      </div>

      <div className="grid grid-cols-1 divide-y md:grid-cols-2 md:divide-x md:divide-y-0">
        <div>
          <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">Expert Ranking</div>
          <div className="flex flex-col">
            {expertRanking.map(([docId, rel], i) => (
              <div key={docId} className="flex items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0">
                <span className="w-4 font-mono text-muted-foreground">{i + 1}</span>
                <span className="flex-1 truncate font-mono">Doc {docId}</span>
                <Badge className={`text-[10px] ${GRADE_COLORS[Math.min(rel, 1)]}`}>
                  {GRADE_LABELS[Math.min(rel, 1)]}
                </Badge>
              </div>
            ))}
            {expertRanking.length === 0 && (
              <p className="p-3 text-xs text-muted-foreground">No relevant documents judged</p>
            )}
          </div>
        </div>

        <div>
          <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">Narsil Ranking</div>
          <div className="flex flex-col">
            {narsilHits.slice(0, 10).map((hit, i) => {
              const docId = String(hit.document.id ?? hit.id)
              const rel = query.judgments.get(docId) ?? 0
              const inExpert = expertRanking.findIndex(([id]) => id === docId)
              const displacement = inExpert >= 0 ? inExpert - i : null

              return (
                <div key={hit.id} className="flex items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0">
                  <span className="w-4 font-mono text-muted-foreground">{i + 1}</span>
                  <span className="flex-1 truncate font-mono">Doc {docId}</span>
                  {displacement !== null && displacement !== 0 && (
                    <span className={`text-[10px] ${displacement > 0 ? 'text-chart-2' : 'text-destructive'}`}>
                      {displacement > 0 ? `\u2191${displacement}` : `\u2193${Math.abs(displacement)}`}
                    </span>
                  )}
                  <Badge className={`text-[10px] ${GRADE_COLORS[Math.min(rel, 1)]}`}>{rel}</Badge>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
