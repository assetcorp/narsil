import type { ListedDocument } from '@delali/narsil'
import type { Table as DocumentTableInstance, Header, Row } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { useCallback } from 'react'
import { formatFieldValue } from '../../lib/display-fields'
import { Button } from '../ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'

interface DocumentTableProps {
  table: DocumentTableInstance<ListedDocument>
  isLoading: boolean
  onSelect: (entry: ListedDocument) => void
}

function sortLabel(direction: false | 'asc' | 'desc'): 'ascending' | 'descending' | 'none' {
  if (direction === 'asc') return 'ascending'
  if (direction === 'desc') return 'descending'
  return 'none'
}

function HeaderCell({ header, sortCount }: { header: Header<ListedDocument, unknown>; sortCount: number }) {
  const { column } = header
  const direction = column.getIsSorted()

  if (!column.getCanSort()) {
    return <TableHead className="font-mono text-xs font-medium">{column.id}</TableHead>
  }

  return (
    <TableHead aria-sort={sortLabel(direction)} className="p-0">
      <button
        type="button"
        onClick={column.getToggleSortingHandler()}
        className="flex h-10 w-full items-center gap-1.5 px-2 font-mono text-xs font-medium transition-colors hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {column.id}
        {direction === 'asc' ? <ArrowUp className="size-3" /> : null}
        {direction === 'desc' ? <ArrowDown className="size-3" /> : null}
        {direction === false ? <ChevronsUpDown className="size-3 opacity-40" /> : null}
        {direction !== false && sortCount > 1 ? (
          <span className="rounded-sm bg-secondary px-1 text-[10px] leading-4 text-secondary-foreground">
            {column.getSortIndex() + 1}
          </span>
        ) : null}
      </button>
    </TableHead>
  )
}

function DocumentRow({ row, onSelect }: { row: Row<ListedDocument>; onSelect: (entry: ListedDocument) => void }) {
  const handleSelect = useCallback(() => {
    onSelect(row.original)
  }, [onSelect, row.original])

  return (
    <TableRow>
      {row.getVisibleCells().map(cell => (
        <TableCell
          key={cell.id}
          className={
            cell.column.id === 'id'
              ? 'font-mono text-xs text-muted-foreground'
              : 'max-w-[22rem] truncate text-xs text-foreground'
          }
        >
          {formatFieldValue(cell.getValue())}
        </TableCell>
      ))}
      <TableCell className="text-right">
        <Button variant="ghost" size="xs" onClick={handleSelect}>
          View
        </Button>
      </TableCell>
    </TableRow>
  )
}

export function DocumentTable({ table, isLoading, onSelect }: DocumentTableProps) {
  const sortCount = table.getState().sorting.length

  return (
    <div
      aria-busy={isLoading}
      className={`rounded-lg border transition-opacity duration-150 ${isLoading ? 'opacity-60' : 'opacity-100'}`}
    >
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map(group => (
            <TableRow key={group.id}>
              {group.headers.map(header => (
                <HeaderCell key={header.id} header={header} sortCount={sortCount} />
              ))}
              <TableHead className="w-16" />
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map(row => (
            <DocumentRow key={row.id} row={row} onSelect={onSelect} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
