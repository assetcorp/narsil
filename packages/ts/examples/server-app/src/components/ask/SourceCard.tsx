import { useCallback } from 'react'
import { Badge } from '#/components/ui/badge'
import type { AskSource } from '#/lib/ask/types'

interface SourceCardProps {
  source: AskSource
  onOpen: (source: AskSource) => void
}

/**
 * One retrieved document in the Sources panel: the citation number the answer
 * refers to, the document title, its retrieval score, and the exact passage
 * Narsil matched. Clicking opens the full document.
 */
export function SourceCard({ source, onOpen }: SourceCardProps) {
  const handleClick = useCallback(() => {
    onOpen(source)
  }, [onOpen, source])

  return (
    <button
      type="button"
      onClick={handleClick}
      className="group w-full cursor-pointer rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/30"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-[10px] font-semibold text-primary">
          {source.rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h4 className="line-clamp-2 text-xs font-semibold leading-snug group-hover:text-primary">{source.title}</h4>
            <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
              {source.score.toFixed(3)}
            </Badge>
          </div>
          <p
            className="mt-1.5 line-clamp-4 text-[11px] leading-relaxed text-muted-foreground [&_mark]:rounded-sm [&_mark]:bg-primary/20 [&_mark]:px-0.5 [&_mark]:text-foreground"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: snippet is sanitized server-side to allow only <mark> tags
            dangerouslySetInnerHTML={{ __html: source.snippet }}
          />
        </div>
      </div>
    </button>
  )
}
