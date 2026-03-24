import type { QueryHit } from '../../backend'
import type { DatasetId } from '../../manifest'
import { Button } from '../ui/button'
import { ResultCard } from './ResultCard'

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
}: ResultListProps) {
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
          <div key={i} className="h-24 animate-pulse rounded-lg border bg-muted/30" />
        ))}
      </div>
    )
  }

  const currentPage = Math.floor(offset / limit)
  const totalPages = Math.ceil(count / limit)

  return (
    <div className="flex flex-col gap-3">
      {hits.map(hit => (
        <ResultCard key={hit.id} hit={hit} datasetId={datasetId} />
      ))}

      {paginationMode === 'offset' && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-4">
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage === 0}
            onClick={() => onPageChange(currentPage - 1)}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {currentPage + 1} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage >= totalPages - 1}
            onClick={() => onPageChange(currentPage + 1)}
          >
            Next
          </Button>
        </div>
      )}

      {paginationMode === 'cursor' && cursor && (
        <div className="flex justify-center pt-4">
          <Button variant="outline" size="sm" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  )
}
