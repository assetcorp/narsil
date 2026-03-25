import type { QueryHit } from '../../backend'
import { Badge } from '../ui/badge'

interface ResultDetailProps {
  hit: QueryHit
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

function isLongText(value: unknown): boolean {
  return typeof value === 'string' && value.length > 120
}

export function ResultDetail({ hit }: ResultDetailProps) {
  const doc = hit.document
  const fields = Object.keys(doc)
  const sc = hit.scoreComponents

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Badge variant="outline" className="font-mono text-xs">
          Score: {hit.score.toFixed(4)}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">ID: {hit.id}</span>
      </div>

      <div>
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Document Fields</h4>
        <div className="flex flex-col gap-2">
          {fields.map(field => {
            const value = doc[field]
            const display = formatValue(value)
            const long = isLongText(value)
            return (
              <div key={field} className="rounded-md border px-3 py-2">
                <span className="mb-0.5 block font-mono text-[11px] font-medium text-primary">{field}</span>
                {long ? (
                  <p className="whitespace-pre-wrap text-xs text-foreground/80">{display}</p>
                ) : (
                  <span className="text-xs text-foreground/80">
                    {display || <em className="text-muted-foreground">empty</em>}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {sc && (
        <div>
          <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Score Components
          </h4>
          <div className="rounded-md border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Field</th>
                  <th className="px-3 py-1.5 text-right font-medium text-muted-foreground">TF</th>
                  <th className="px-3 py-1.5 text-right font-medium text-muted-foreground">IDF</th>
                  <th className="px-3 py-1.5 text-right font-medium text-muted-foreground">Field Length</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(sc.termFrequencies).map(field => (
                  <tr key={field} className="border-b last:border-b-0">
                    <td className="px-3 py-1.5 font-mono">{field}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{sc.termFrequencies[field]}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{sc.idf[field]?.toFixed(3) ?? '-'}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{sc.fieldLengths[field] ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {hit.highlights && Object.keys(hit.highlights).length > 0 && (
        <div>
          <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Highlights</h4>
          <div className="flex flex-col gap-2">
            {Object.entries(hit.highlights).map(([field, hl]) => (
              <div key={field} className="rounded-md border px-3 py-2">
                <span className="mb-0.5 block font-mono text-[11px] font-medium text-primary">{field}</span>
                <p
                  className="text-xs text-foreground/80 [&_mark]:rounded-sm [&_mark]:bg-primary/20 [&_mark]:px-0.5"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight markup from search engine
                  dangerouslySetInnerHTML={{ __html: hl.snippet }}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
