import { useCallback, useState } from 'react'
import type { QueryHit } from '../../backend'
import { type DisplayFieldMapping, displayHeading } from '../../lib/display-fields'
import type { DatasetId } from '../../manifest'
import { Pagination } from '../Pagination'
import { Button } from '../ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { Skeleton } from '../ui/skeleton'
import { ResultCard } from './ResultCard'
import { ResultDetail } from './ResultDetail'

interface ResultListProps {
  hits: QueryHit[]
  isLoading: boolean
  error: string | null
  count: number
  limit: number
  offset: number
  cursor?: string
  paginationMode: 'offset' | 'cursor'
  onPageChange: (page: number) => void
  onLoadMore: () => void
  datasetId: DatasetId
  displayFields: DisplayFieldMapping | null
}

function ResultHitCard({
  hit,
  datasetId,
  displayFields,
  onSelect,
}: {
  hit: QueryHit
  datasetId: DatasetId
  displayFields: DisplayFieldMapping | null
  onSelect: (hit: QueryHit) => void
}) {
  const handleClick = useCallback(() => {
    onSelect(hit)
  }, [onSelect, hit])

  return <ResultCard hit={hit} datasetId={datasetId} displayFields={displayFields} onClick={handleClick} />
}

export function ResultList({
  hits,
  isLoading,
  error,
  count,
  limit,
  offset,
  cursor,
  paginationMode,
  onPageChange,
  onLoadMore,
  datasetId,
  displayFields,
}: ResultListProps) {
  const [selectedHit, setSelectedHit] = useState<QueryHit | null>(null)
  const currentPage = Math.floor(offset / limit)
  const totalPages = Math.ceil(count / limit)

  const handleSheetOpenChange = useCallback((open: boolean) => {
    if (!open) setSelectedHit(null)
  }, [])

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
        {error}
      </div>
    )
  }

  if (!isLoading && hits.length === 0 && count === 0) {
    return <div className="py-12 text-center text-sm text-muted-foreground">Type a search query to see results.</div>
  }

  if (isLoading && hits.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
    )
  }

  const selectedTitle = selectedHit ? displayHeading(selectedHit.document, displayFields, selectedHit.id) : ''

  return (
    <>
      <div className="flex flex-col gap-3">
        {hits.map(hit => (
          <ResultHitCard
            key={hit.id}
            hit={hit}
            datasetId={datasetId}
            displayFields={displayFields}
            onSelect={setSelectedHit}
          />
        ))}

        {paginationMode === 'offset' && (
          <Pagination page={currentPage} totalPages={totalPages} onPageChange={onPageChange} />
        )}

        {paginationMode === 'cursor' && cursor && (
          <div className="flex justify-center pt-4">
            <Button variant="outline" size="sm" onClick={onLoadMore}>
              Load more
            </Button>
          </div>
        )}
      </div>

      <Sheet open={selectedHit !== null} onOpenChange={handleSheetOpenChange}>
        <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="truncate">{selectedTitle}</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">{selectedHit && <ResultDetail hit={selectedHit} />}</div>
        </SheetContent>
      </Sheet>
    </>
  )
}
