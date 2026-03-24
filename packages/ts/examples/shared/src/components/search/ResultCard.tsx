import { Badge } from '../ui/badge'
import type { QueryHit } from '../../backend'
import type { DatasetId } from '../../manifest'

interface ResultCardProps {
  hit: QueryHit
  datasetId: DatasetId
}

function sanitizeHighlight(html: string): string {
  return html.replace(/<(?!\/?mark\b)[^>]*>/gi, (match) => {
    return match.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  })
}

export function ResultCard({ hit, datasetId }: ResultCardProps) {
  const doc = hit.document
  const highlights = hit.highlights

  function renderHighlightedText(field: string, fallback: string): React.ReactNode {
    const hl = highlights?.[field]
    if (hl) {
      return <span dangerouslySetInnerHTML={{ __html: sanitizeHighlight(hl.snippet) }} />
    }
    return fallback
  }

  if (datasetId === 'tmdb') {
    const title = String(doc.title ?? '')
    const overview = String(doc.overview ?? '')
    const genres = (doc.genres as string[]) ?? []
    const year = doc.release_year as number
    const rating = doc.vote_average as number

    return (
      <div className="rounded-lg border p-4 transition-colors hover:bg-muted/30">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold">
                {renderHighlightedText('title', title)}
              </h3>
              {year && <span className="shrink-0 text-xs text-muted-foreground">{year}</span>}
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {renderHighlightedText('overview', overview)}
            </p>
            {genres.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {genres.map((g) => (
                  <Badge key={g} variant="secondary" className="text-[10px]">
                    {g}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge variant="outline" className="font-mono text-[10px]">
              {hit.score.toFixed(3)}
            </Badge>
            {rating > 0 && (
              <span className="text-[10px] text-muted-foreground">{rating.toFixed(1)}/10</span>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (datasetId === 'wikipedia') {
    const title = String(doc.title ?? '')
    const text = String(doc.text ?? '').slice(0, 200)
    const language = String(doc.language ?? '')
    const categories = (doc.categories as string[]) ?? []

    return (
      <div className="rounded-lg border p-4 transition-colors hover:bg-muted/30">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold">
                {renderHighlightedText('title', title)}
              </h3>
              <Badge variant="secondary" className="text-[10px] font-mono uppercase">{language}</Badge>
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {renderHighlightedText('text', text)}
            </p>
            {categories.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {categories.slice(0, 3).map((c) => (
                  <Badge key={c} variant="outline" className="text-[10px]">
                    {c}
                  </Badge>
                ))}
                {categories.length > 3 && (
                  <span className="text-[10px] text-muted-foreground">+{categories.length - 3}</span>
                )}
              </div>
            )}
          </div>
          <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
            {hit.score.toFixed(3)}
          </Badge>
        </div>
      </div>
    )
  }

  const title = String(doc.title ?? doc.id ?? hit.id)
  const body = String(doc.body ?? doc.text ?? doc.overview ?? '').slice(0, 200)

  return (
    <div className="rounded-lg border p-4 transition-colors hover:bg-muted/30">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{title}</h3>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{body}</p>
        </div>
        <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
          {hit.score.toFixed(3)}
        </Badge>
      </div>
    </div>
  )
}
