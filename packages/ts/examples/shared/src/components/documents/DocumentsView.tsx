import type { ListedDocument, ListResult } from '@delali/narsil'
import { getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDisplayFields } from '../../hooks/use-display-fields'
import { DOCUMENT_PAGE_SIZE, type DocumentBrowser } from '../../hooks/use-document-browser'
import type { IndexSchemaView } from '../../hooks/use-index-schema'
import { displayHeading } from '../../lib/display-fields'
import { useActiveIndex, useIndexWorkspace } from '../../workspace'
import { IndexSelector } from '../IndexSelector'
import { Pagination } from '../Pagination'
import { ResultDetail } from '../search/ResultDetail'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet'
import { Skeleton } from '../ui/skeleton'
import { buildDocumentColumns, collectFieldPaths } from './columns'
import { DocumentTable } from './DocumentTable'
import { DocumentToolbar } from './DocumentToolbar'
import { FilterPanel } from './FilterPanel'

const SKELETON_ROW_KEYS = Array.from({ length: DOCUMENT_PAGE_SIZE }, (_, index) => `placeholder-${index}`)
const MAX_SORT_FIELDS = 8
const NO_DOCUMENTS: ListedDocument[] = []

export interface DocumentsViewProps {
  browser: DocumentBrowser
  schema: IndexSchemaView
  list: ListResult | undefined
  isLoading: boolean
  isFetching: boolean
  error: Error | undefined
}

function getDocumentRowId(row: ListedDocument): string {
  return row.id
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

export function DocumentsView({ browser, schema, list, isLoading, isFetching, error }: DocumentsViewProps) {
  const { activeIndexName } = useIndexWorkspace()
  const activeIndex = useActiveIndex()
  const displayFields = useDisplayFields(activeIndexName)
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false)
  const [selected, setSelected] = useState<ListedDocument | null>(null)

  const { hideColumns, recordCursor } = browser
  const vectorPaths = schema.vectorPaths

  useEffect(() => {
    hideColumns(vectorPaths)
  }, [hideColumns, vectorPaths])

  useEffect(() => {
    recordCursor(list)
  }, [recordCursor, list])

  const documents = list?.documents ?? NO_DOCUMENTS
  const schemaPaths = useMemo(() => schema.leaves.map(leaf => leaf.path), [schema.leaves])
  const fieldPaths = useMemo(() => collectFieldPaths(documents, schemaPaths), [documents, schemaPaths])
  const columns = useMemo(
    () => buildDocumentColumns(fieldPaths, schema.sortablePaths),
    [fieldPaths, schema.sortablePaths],
  )

  const table = useReactTable({
    data: documents,
    columns,
    state: { sorting: browser.sorting, columnVisibility: browser.columnVisibility },
    onSortingChange: browser.setSorting,
    onColumnVisibilityChange: browser.setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getRowId: getDocumentRowId,
    manualSorting: true,
    manualPagination: true,
    enableMultiSort: true,
    maxMultiSortColCount: MAX_SORT_FIELDS,
  })

  const handleSheetOpenChange = useCallback((open: boolean) => {
    if (!open) setSelected(null)
  }, [])

  const handleFilterPanelToggle = useCallback(() => {
    setIsFilterPanelOpen(open => !open)
  }, [])

  if (activeIndexName === null) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Documents</h1>
        <p className="text-sm text-muted-foreground">
          Load a dataset from the Datasets tab to browse the documents it indexed.
        </p>
      </div>
    )
  }

  const total = list?.total ?? 0
  const first = browser.page * browser.pageSize + 1
  const last = browser.page * browser.pageSize + documents.length
  const totalPages = Math.ceil(total / browser.pageSize)
  const selectedTitle = selected ? displayHeading(selected.document, displayFields, selected.id) : ''
  const isFiltered = browser.activeFilterCount > 0

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="mb-1 text-3xl font-bold tracking-tight">Documents</h1>
        {activeIndex ? (
          <p className="text-sm text-muted-foreground">
            Browsing <span className="font-mono font-medium text-foreground">{activeIndex.name}</span> in{' '}
            {browser.orderDescription}
          </p>
        ) : null}
      </div>

      <IndexSelector />

      <DocumentToolbar
        table={table}
        activeFilterCount={browser.activeFilterCount}
        isFilterPanelOpen={isFilterPanelOpen}
        onFilterPanelToggle={handleFilterPanelToggle}
        pageSize={browser.pageSize}
        onPageSizeChange={browser.setPageSize}
      />

      {isFilterPanelOpen ? (
        <div className="mb-4 rounded-lg border bg-card p-4 shadow-xs">
          <FilterPanel fields={schema.fields} rules={browser.rules} onChange={browser.setRules} />
        </div>
      ) : null}

      <div className="mb-3 flex min-h-4 items-center gap-3 text-xs text-muted-foreground">
        {documents.length > 0 ? (
          <>
            <span>
              {first.toLocaleString()}-{last.toLocaleString()} of {total.toLocaleString()} document
              {total === 1 ? '' : 's'}
              {isFiltered ? ' matching' : ''}
            </span>
            <span className="font-mono">{(list?.elapsed ?? 0).toFixed(1)}ms</span>
          </>
        ) : null}
      </div>

      {error === undefined ? null : (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
          {error.message}
        </div>
      )}

      {error !== undefined || list !== undefined ? null : <DocumentSkeleton />}

      {error === undefined && list !== undefined && documents.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {isFiltered ? 'No document matches these conditions.' : 'This index holds no documents yet.'}
        </div>
      ) : null}

      {error === undefined && documents.length > 0 ? (
        <DocumentTable table={table} isLoading={isFetching} onSelect={setSelected} />
      ) : null}

      {error === undefined ? (
        <Pagination
          page={browser.page}
          totalPages={totalPages}
          onPageChange={browser.setPage}
          disabled={isLoading || isFetching}
        />
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
