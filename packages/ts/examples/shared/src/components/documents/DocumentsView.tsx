import { type Dispatch, useCallback, useMemo, useState } from 'react'
import type { ListedDocument, NarsilBackend } from '../../backend'
import { useDisplayFields } from '../../hooks/use-display-fields'
import { DOCUMENT_PAGE_SIZE, useDocumentList } from '../../hooks/use-document-list'
import { displayHeading, formatFieldValue } from '../../lib/display-fields'
import type { AppAction, AppState } from '../../types'
import { Pagination } from '../Pagination'
import { ResultDetail } from '../search/ResultDetail'
import { Button } from '../ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet'
import { Skeleton } from '../ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'

const ID_FIELD = 'id'
const SKELETON_ROW_KEYS = Array.from({ length: DOCUMENT_PAGE_SIZE }, (_, index) => `placeholder-${index}`)

interface DocumentsViewProps {
  backend: NarsilBackend
  state: AppState
  dispatch: Dispatch<AppAction>
}

function collectColumns(documents: ListedDocument[]): string[] {
  const columns: string[] = []
  const seen = new Set<string>([ID_FIELD])
  for (const entry of documents) {
    for (const field of Object.keys(entry.document)) {
      if (seen.has(field)) continue
      seen.add(field)
      columns.push(field)
    }
  }
  return columns
}

function IndexButton({ name, active, dispatch }: { name: string; active: boolean; dispatch: Dispatch<AppAction> }) {
  const handleClick = useCallback(() => {
    dispatch({ type: 'SET_ACTIVE_INDEX', payload: name })
  }, [dispatch, name])

  return (
    <Button variant={active ? 'default' : 'outline'} size="xs" className="font-mono text-xs" onClick={handleClick}>
      {name}
    </Button>
  )
}

function DocumentRow({
  entry,
  columns,
  onSelect,
}: {
  entry: ListedDocument
  columns: string[]
  onSelect: (entry: ListedDocument) => void
}) {
  const handleSelect = useCallback(() => {
    onSelect(entry)
  }, [onSelect, entry])

  return (
    <TableRow>
      <TableCell className="font-mono text-xs text-muted-foreground">{entry.id}</TableCell>
      {columns.map(column => (
        <TableCell key={column} className="max-w-xs truncate text-xs">
          {formatFieldValue(entry.document[column])}
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

function DocumentSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-2">
      {SKELETON_ROW_KEYS.map(key => (
        <Skeleton key={key} className="h-9 rounded-md" />
      ))}
    </div>
  )
}

function DocumentPanel({
  documents,
  columns,
  isLoading,
  onSelect,
}: {
  documents: ListedDocument[]
  columns: string[]
  isLoading: boolean
  onSelect: (entry: ListedDocument) => void
}) {
  return (
    <div
      aria-busy={isLoading}
      className={`rounded-lg border transition-opacity duration-150 ${isLoading ? 'opacity-60' : 'opacity-100'}`}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="font-mono text-xs">id</TableHead>
            {columns.map(column => (
              <TableHead key={column} className="font-mono text-xs">
                {column}
              </TableHead>
            ))}
            <TableHead className="w-16" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map(entry => (
            <DocumentRow key={entry.id} entry={entry} columns={columns} onSelect={onSelect} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function DocumentsView({ backend, state, dispatch }: DocumentsViewProps) {
  const indexName = state.activeIndexName
  const list = useDocumentList(backend, indexName)
  const displayFields = useDisplayFields(indexName)
  const [selected, setSelected] = useState<ListedDocument | null>(null)
  const columns = useMemo(() => collectColumns(list.documents), [list.documents])

  const handleSheetOpenChange = useCallback((open: boolean) => {
    if (!open) setSelected(null)
  }, [])

  if (!indexName) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Documents</h1>
        <p className="text-sm text-muted-foreground">
          Load a dataset from the Datasets tab to browse the documents it indexed.
        </p>
      </div>
    )
  }

  const activeIndex = state.indexes.find(i => i.name === indexName)
  const first = list.page * DOCUMENT_PAGE_SIZE + 1
  const last = list.page * DOCUMENT_PAGE_SIZE + list.documents.length
  const totalPages = Math.ceil(list.total / DOCUMENT_PAGE_SIZE)
  const selectedTitle = selected ? displayHeading(selected.document, displayFields, selected.id) : ''

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="mb-1 text-3xl font-bold tracking-tight">Documents</h1>
        {activeIndex ? (
          <p className="text-sm text-muted-foreground">
            Browsing <span className="font-mono font-medium text-foreground">{activeIndex.name}</span> in document-id
            order
          </p>
        ) : null}
      </div>

      {state.indexes.length > 1 ? (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {state.indexes.map(idx => (
            <IndexButton key={idx.name} name={idx.name} active={idx.name === indexName} dispatch={dispatch} />
          ))}
        </div>
      ) : null}

      <div className="mb-3 flex min-h-4 items-center gap-3 text-xs text-muted-foreground">
        {list.documents.length > 0 ? (
          <>
            <span>
              {first.toLocaleString()}-{last.toLocaleString()} of {list.total.toLocaleString()} document
              {list.total === 1 ? '' : 's'}
            </span>
            <span className="font-mono">{list.elapsed.toFixed(1)}ms</span>
          </>
        ) : null}
      </div>

      {list.error === null ? null : (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
          {list.error}
        </div>
      )}

      {list.error !== null || list.hasLoaded ? null : <DocumentSkeleton />}

      {list.error === null && list.hasLoaded && list.documents.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">This index holds no documents yet.</div>
      ) : null}

      {list.error === null && list.documents.length > 0 ? (
        <DocumentPanel documents={list.documents} columns={columns} isLoading={list.isLoading} onSelect={setSelected} />
      ) : null}

      {list.error === null ? (
        <Pagination page={list.page} totalPages={totalPages} onPageChange={list.setPage} disabled={list.isLoading} />
      ) : null}

      <Sheet open={selected !== null} onOpenChange={handleSheetOpenChange}>
        <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="truncate">{selectedTitle}</SheetTitle>
            <SheetDescription>Every stored field for this document.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">{selected === null ? null : <ResultDetail hit={selected} />}</div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
