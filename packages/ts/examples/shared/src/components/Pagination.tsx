import { useCallback } from 'react'
import { Button } from './ui/button'

interface PaginationProps {
  page: number
  totalPages: number
  onPageChange: (page: number) => void
  disabled?: boolean
}

export function Pagination({ page, totalPages, onPageChange, disabled = false }: PaginationProps) {
  const handlePrevious = useCallback(() => {
    onPageChange(page - 1)
  }, [onPageChange, page])

  const handleNext = useCallback(() => {
    onPageChange(page + 1)
  }, [onPageChange, page])

  if (totalPages <= 1) return null

  return (
    <div className="flex items-center justify-center gap-2 pt-4">
      <Button variant="outline" size="sm" disabled={disabled || page === 0} onClick={handlePrevious}>
        Previous
      </Button>
      <span className="text-xs text-muted-foreground">
        Page {page + 1} of {totalPages}
      </span>
      <Button variant="outline" size="sm" disabled={disabled || page >= totalPages - 1} onClick={handleNext}>
        Next
      </Button>
    </div>
  )
}
