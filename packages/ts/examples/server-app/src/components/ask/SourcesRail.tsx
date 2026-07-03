import { FileSearch } from 'lucide-react'
import { Badge } from '#/components/ui/badge'
import { ScrollArea } from '#/components/ui/scroll-area'
import { RETRIEVAL_MODE_OPTIONS } from '#/lib/ask/client'
import type { AskSource, AskSourcesData } from '#/lib/ask/types'
import { SourceCard } from './SourceCard'

interface SourcesRailProps {
  retrieval: AskSourcesData | null
  onOpenSource: (source: AskSource) => void
}

function modeLabel(mode: AskSourcesData['mode']): string {
  return RETRIEVAL_MODE_OPTIONS.find(option => option.id === mode)?.label ?? mode
}

/**
 * The receipts column: every document the latest answer was grounded on,
 * with the retrieval mode and engine time that produced it.
 */
export function SourcesRail({ retrieval, onOpenSource }: SourcesRailProps) {
  return (
    <aside className="flex h-full min-h-0 flex-col rounded-xl border bg-card/50">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <FileSearch className="size-4 text-primary" />
          <h2 className="text-sm font-semibold">Sources</h2>
        </div>
        {retrieval && retrieval.sources.length > 0 && (
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="text-[10px]">
              {modeLabel(retrieval.mode)}
            </Badge>
            <span className="font-mono text-[10px] text-muted-foreground">{retrieval.elapsedMs.toFixed(1)}ms</span>
          </div>
        )}
      </div>

      {!retrieval && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <FileSearch className="size-6 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">
            Ask a question and the documents behind the answer appear here, with the exact passages Narsil retrieved.
          </p>
        </div>
      )}

      {retrieval && retrieval.sources.length === 0 && (
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <p className="text-xs text-muted-foreground">
            Nothing matched this question in {modeLabel(retrieval.mode).toLowerCase()} mode.
          </p>
        </div>
      )}

      {retrieval && retrieval.sources.length > 0 && (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 p-3">
            <p className="px-1 text-[11px] text-muted-foreground">
              Retrieved for <span className="font-medium text-foreground">{retrieval.query}</span>
            </p>
            {retrieval.sources.map(source => (
              <SourceCard key={source.docId} source={source} onOpen={onOpenSource} />
            ))}
          </div>
        </ScrollArea>
      )}
    </aside>
  )
}
