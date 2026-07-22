import { ChevronDown, FileSearch } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '#/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#/components/ui/collapsible'
import { ScrollArea } from '#/components/ui/scroll-area'
import { RETRIEVAL_MODE_OPTIONS } from '#/lib/ask/client'
import type { AskSource, AskSourcesData } from '#/lib/ask/types'
import { cn } from '#/lib/utils'
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
  const [open, setOpen] = useState(false)
  const sourceCount = retrieval?.sources.length ?? 0

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn('flex min-h-0 flex-col rounded-xl border bg-card/50', open && 'h-full')}
    >
      <CollapsibleTrigger
        className={cn(
          'flex w-full shrink-0 items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/40',
          open ? 'rounded-t-xl' : 'rounded-xl',
        )}
        aria-label={open ? 'Collapse the sources panel' : 'Expand the sources panel'}
      >
        <div className="flex items-center gap-2">
          <FileSearch className="size-4 text-primary" />
          <span className="text-sm font-semibold">Sources</span>
          {!open && sourceCount > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {sourceCount}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {open && retrieval && sourceCount > 0 && (
            <>
              <Badge variant="secondary" className="text-[10px]">
                {modeLabel(retrieval.mode)}
              </Badge>
              <span className="font-mono text-[10px] text-muted-foreground">{retrieval.elapsedMs.toFixed(1)}ms</span>
            </>
          )}
          <ChevronDown
            className={cn('size-4 text-muted-foreground transition-transform', open ? 'rotate-180' : 'rotate-0')}
          />
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent className="flex min-h-0 flex-1 flex-col border-t outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2 motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none">
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
      </CollapsibleContent>
    </Collapsible>
  )
}
