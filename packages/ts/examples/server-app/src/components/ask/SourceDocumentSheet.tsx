import type { Hit } from '@delali/narsil'
import { useDocument } from '@delali/narsil/react'
import { ResultDetail } from '@delali/narsil-example-shared/components/search/ResultDetail'
import { useCallback } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '#/components/ui/sheet'
import { Skeleton } from '#/components/ui/skeleton'
import type { AskSource } from '#/lib/ask/types'

interface SourceDocumentSheetProps {
  source: AskSource | null
  onClose: () => void
}

/**
 * Full-document viewer for a cited source. The document is read on demand so
 * answer streams stay small, and it can be gone when its index was dropped
 * after the answer was written.
 */
export function SourceDocumentSheet({ source, onClose }: SourceDocumentSheetProps) {
  const document = useDocument(source?.indexName ?? '', source?.docId, { enabled: source !== null })

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose()
    },
    [onClose],
  )

  const hit: Hit | null =
    source !== null && document.data !== undefined
      ? { id: source.docId, score: source.score, document: document.data }
      : null

  return (
    <Sheet open={source !== null} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="truncate pr-6">{source?.title}</SheetTitle>
          <SheetDescription>
            Source [{source?.rank}] from <span className="font-mono">{source?.indexName}</span>
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {document.isLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : null}
          {document.error !== undefined ? <p className="text-sm text-destructive">{document.error.message}</p> : null}
          {!document.isLoading && document.error === undefined && hit === null ? (
            <p className="text-sm text-muted-foreground">
              This document is no longer in the index. It may have been removed, or the dataset reloaded since the
              answer was written.
            </p>
          ) : null}
          {hit === null ? null : <ResultDetail hit={hit} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}
