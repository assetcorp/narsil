import { FileSearch, History } from 'lucide-react'
import { useCallback, useState } from 'react'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '#/components/ui/sheet'
import type { AskSource, AskSourcesData } from '#/lib/ask/types'
import type { ThreadSummary } from '#/lib/chat/types'
import { modeLabel, SourcesRailContent } from './SourcesRail'
import { ThreadSidebar } from './ThreadSidebar'

interface ThreadsSheetProps {
  threads: ThreadSummary[]
  activeThreadId: string | null
  isThreadNew: (id: string) => boolean
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

export function ThreadsSheet({ threads, activeThreadId, isThreadNew, onSelect, onNew, onDelete }: ThreadsSheetProps) {
  const [open, setOpen] = useState(false)

  const handleSelect = useCallback(
    (id: string) => {
      setOpen(false)
      onSelect(id)
    },
    [onSelect],
  )

  const handleNew = useCallback(() => {
    setOpen(false)
    onNew()
  }, [onNew])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="lg:hidden">
          <History className="size-3.5" />
          History
          {threads.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {threads.length}
            </Badge>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 gap-0">
        <SheetHeader className="border-b">
          <SheetTitle className="text-sm">Conversations</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 p-3">
          <ThreadSidebar
            threads={threads}
            activeThreadId={activeThreadId}
            isThreadNew={isThreadNew}
            onSelect={handleSelect}
            onNew={handleNew}
            onDelete={onDelete}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}

interface SourcesSheetProps {
  retrieval: AskSourcesData | null
  onOpenSource: (source: AskSource) => void
}

export function SourcesSheet({ retrieval, onOpenSource }: SourcesSheetProps) {
  const [open, setOpen] = useState(false)
  const sourceCount = retrieval?.sources.length ?? 0

  const handleOpenSource = useCallback(
    (source: AskSource) => {
      setOpen(false)
      onOpenSource(source)
    },
    [onOpenSource],
  )

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="xl:hidden">
          <FileSearch className="size-3.5" />
          Sources
          {sourceCount > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {sourceCount}
            </Badge>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-80 flex-col gap-0">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2 text-sm">
            Sources
            {retrieval && sourceCount > 0 && (
              <>
                <Badge variant="secondary" className="text-[10px]">
                  {modeLabel(retrieval.mode)}
                </Badge>
                <span className="font-mono text-[10px] font-normal text-muted-foreground">
                  {retrieval.elapsedMs.toFixed(1)}ms
                </span>
              </>
            )}
          </SheetTitle>
        </SheetHeader>
        <SourcesRailContent retrieval={retrieval} onOpenSource={handleOpenSource} />
      </SheetContent>
    </Sheet>
  )
}
