import { useState, useEffect } from 'react'
import { Badge } from '../ui/badge'
import type { QueryMetrics } from '../../lib/metrics'
import type { NarsilBackend, QueryHit } from '../../backend'

interface SideBySideProps {
  query: QueryMetrics
  backend: NarsilBackend
}

const GRADE_LABELS = ['Not relevant', 'Marginally', 'Relevant', 'Highly', 'Key']
const GRADE_COLORS = [
  'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
]

export function SideBySide({ query, backend }: SideBySideProps) {
  const [narsilHits, setNarsilHits] = useState<QueryHit[]>([])

  useEffect(() => {
    let cancelled = false
    backend
      .query({ indexName: 'cranfield', term: query.queryText, limit: 10 })
      .then((res) => { if (!cancelled) setNarsilHits(res.hits) })
    return () => { cancelled = true }
  }, [backend, query.queryText])

  const expertRanking = Array.from(query.judgments.entries())
    .filter(([, rel]) => rel > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)

  return (
    <div className="rounded-lg border">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Query #{query.queryId}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{query.queryText}</p>
      </div>

      <div className="grid grid-cols-2 divide-x">
        <div>
          <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">
            Expert Ranking
          </div>
          <div className="flex flex-col">
            {expertRanking.map(([docId, rel], i) => (
              <div key={docId} className="flex items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0">
                <span className="w-4 font-mono text-muted-foreground">{i + 1}</span>
                <span className="flex-1 truncate font-mono">Doc {docId}</span>
                <Badge className={`text-[10px] ${GRADE_COLORS[Math.min(rel, 4)]}`}>
                  {GRADE_LABELS[Math.min(rel, 4)]}
                </Badge>
              </div>
            ))}
            {expertRanking.length === 0 && (
              <p className="p-3 text-xs text-muted-foreground">No relevant documents judged</p>
            )}
          </div>
        </div>

        <div>
          <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">
            Narsil Ranking
          </div>
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
                    <span className={`text-[10px] ${displacement > 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {displacement > 0 ? `\u2191${displacement}` : `\u2193${Math.abs(displacement)}`}
                    </span>
                  )}
                  <Badge className={`text-[10px] ${GRADE_COLORS[Math.min(rel, 4)]}`}>
                    {rel}
                  </Badge>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
