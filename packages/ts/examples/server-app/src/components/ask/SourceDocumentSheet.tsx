import type { QueryHit } from '@delali/narsil-example-shared'
import { ResultDetail } from '@delali/narsil-example-shared/components/search/ResultDetail'
import { useCallback, useEffect, useState } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '#/components/ui/sheet'
import { Skeleton } from '#/components/ui/skeleton'
import type { AskSource } from '#/lib/ask/types'
import { getDocumentFn } from '#/lib/server-fns'

interface SourceDocumentSheetProps {
  source: AskSource | null
  onClose: () => void
}

type DocumentState =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'error'; message: string }
  | { phase: 'loaded'; hit: QueryHit }

/**
 * Full-document viewer for a cited source. The document is fetched on demand
 * so answer streams stay small; a document can be missing when its index was
 * dropped after the answer was produced.
 */
export function SourceDocumentSheet({ source, onClose }: SourceDocumentSheetProps) {
  const [state, setState] = useState<DocumentState>({ phase: 'loading' })

  useEffect(() => {
    if (!source) return
    let cancelled = false
    setState({ phase: 'loading' })
    getDocumentFn({ data: { indexName: source.indexName, docId: source.docId } })
      .then(document => {
        if (cancelled) return
        if (!document) {
          setState({ phase: 'missing' })
          return
        }
        setState({
          phase: 'loaded',
          hit: { id: source.docId, score: source.score, document },
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [source])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose()
    },
    [onClose],
  )

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
          {state.phase === 'loading' && (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
          {state.phase === 'missing' && (
            <p className="text-sm text-muted-foreground">
              This document is no longer in the index. It may have been removed or the dataset reloaded since the answer
              was produced.
            </p>
          )}
          {state.phase === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
          {state.phase === 'loaded' && <ResultDetail hit={state.hit} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}
