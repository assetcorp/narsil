import { Badge } from '../ui/badge'
import type { RecomputedHit } from '../../scoring'

interface ScoreBreakdownProps {
  recomputedHits: RecomputedHit[]
  fields: string[]
}

function getFieldStats(
  components: { termFrequencies: Record<string, number>; idf: Record<string, number>; fieldLengths: Record<string, number> } | undefined,
  fieldName: string
): { tf: number; idf: number; fl: number } {
  if (!components) return { tf: 0, idf: 0, fl: 0 }

  let tf = 0
  let idf = 0
  const fl = components.fieldLengths[fieldName] ?? 0

  for (const [key, value] of Object.entries(components.termFrequencies)) {
    const colonIndex = key.indexOf(':')
    if (colonIndex === -1) continue
    if (key.slice(0, colonIndex) === fieldName) {
      tf += value
      const token = key.slice(colonIndex + 1)
      idf = Math.max(idf, components.idf[token] ?? 0)
    }
  }

  return { tf, idf, fl }
}

export function ScoreBreakdown({ recomputedHits, fields }: ScoreBreakdownProps) {
  if (recomputedHits.length === 0) return null

  return (
    <div className="rounded-lg border">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Score Breakdown</h3>
        <p className="text-xs text-muted-foreground">Per-field contribution for each result</p>
      </div>
      <div className="max-h-96 overflow-y-auto">
        {recomputedHits.slice(0, 20).map((item) => {
          const doc = item.hit.document
          const title = String(doc.title ?? doc.id ?? item.hit.id)
          const maxFieldScore = Math.max(...Object.values(item.fieldScores), 0.001)

          return (
            <div key={item.hit.id} className="border-b p-3 last:border-b-0">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium">{title}</span>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {item.recomputedScore.toFixed(3)}
                </Badge>
              </div>

              <div className="mt-2 flex flex-col gap-1">
                {fields.map((field) => {
                  const score = item.fieldScores[field] ?? 0
                  const width = maxFieldScore > 0 ? (score / maxFieldScore) * 100 : 0
                  const stats = getFieldStats(item.hit.scoreComponents, field)

                  return (
                    <div key={field} className="flex items-center gap-2">
                      <span className="w-16 shrink-0 truncate text-[10px] text-muted-foreground">
                        {field}
                      </span>
                      <div className="flex-1">
                        <div className="h-1.5 rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${Math.min(width, 100)}%` }}
                          />
                        </div>
                      </div>
                      <span className="w-12 text-right font-mono text-[10px]">{score.toFixed(3)}</span>
                      <span className="w-32 text-right text-[9px] text-muted-foreground">
                        tf={stats.tf.toFixed(1)} idf={stats.idf.toFixed(2)} len={stats.fl}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
