import type { ListedDocument } from '@delali/narsil'
import type { Column, Table as DocumentTableInstance } from '@tanstack/react-table'
import { ArrowUpDown, Columns3, SlidersHorizontal } from 'lucide-react'
import { useCallback } from 'react'
import { DOCUMENT_PAGE_SIZES } from '../../hooks/use-document-browser'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

interface DocumentToolbarProps {
  table: DocumentTableInstance<ListedDocument>
  activeFilterCount: number
  isFilterPanelOpen: boolean
  onFilterPanelToggle: () => void
  pageSize: number
  onPageSizeChange: (size: number) => void
}

function ColumnToggle({ column }: { column: Column<ListedDocument, unknown> }) {
  const handleCheckedChange = useCallback(
    (checked: boolean) => {
      column.toggleVisibility(checked)
    },
    [column],
  )

  return (
    <DropdownMenuCheckboxItem
      checked={column.getIsVisible()}
      onCheckedChange={handleCheckedChange}
      className="font-mono text-xs"
    >
      {column.id}
    </DropdownMenuCheckboxItem>
  )
}

export function DocumentToolbar({
  table,
  activeFilterCount,
  isFilterPanelOpen,
  onFilterPanelToggle,
  pageSize,
  onPageSizeChange,
}: DocumentToolbarProps) {
  const sorting = table.getState().sorting
  const hideableColumns = table.getAllLeafColumns().filter(column => column.getCanHide())
  const hiddenCount = hideableColumns.filter(column => !column.getIsVisible()).length

  const handleClearSort = useCallback(() => {
    table.resetSorting(true)
  }, [table])

  const handlePageSizeChange = useCallback(
    (value: string) => {
      onPageSizeChange(Number(value))
    },
    [onPageSizeChange],
  )

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant={isFilterPanelOpen ? 'secondary' : 'outline'}
        size="sm"
        onClick={onFilterPanelToggle}
        aria-expanded={isFilterPanelOpen}
      >
        <SlidersHorizontal className="size-3.5" />
        Filters
        {activeFilterCount > 0 ? (
          <Badge variant="default" className="ml-1 px-1.5 text-[10px]">
            {activeFilterCount}
          </Badge>
        ) : null}
      </Button>

      {sorting.length > 0 ? (
        <Button type="button" variant="ghost" size="sm" onClick={handleClearSort}>
          <ArrowUpDown className="size-3.5" />
          Clear sort
          <Badge variant="secondary" className="ml-1 px-1.5 text-[10px]">
            {sorting.length}
          </Badge>
        </Button>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              <Columns3 className="size-3.5" />
              Columns
              {hiddenCount > 0 ? (
                <Badge variant="secondary" className="ml-1 px-1.5 text-[10px]">
                  {hideableColumns.length - hiddenCount}/{hideableColumns.length}
                </Badge>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
            <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {hideableColumns.map(column => (
              <ColumnToggle key={column.id} column={column} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Select value={String(pageSize)} onValueChange={handlePageSizeChange}>
          <SelectTrigger size="sm" className="text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {DOCUMENT_PAGE_SIZES.map(size => (
              <SelectItem key={size} value={String(size)} className="text-xs">
                {size} per page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
