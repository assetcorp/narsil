import { getCoreRowModel, type SortingState, useReactTable, type VisibilityState } from '@tanstack/react-table'
import { type Dispatch, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ListedDocument, NarsilBackend } from '../../backend'
import { useDisplayFields } from '../../hooks/use-display-fields'
import { DOCUMENT_PAGE_SIZE, useDocumentList } from '../../hooks/use-document-list'
import { useIndexSchema } from '../../hooks/use-index-schema'
import { displayHeading } from '../../lib/display-fields'
import { buildFilterExpression, type FilterRule, isRuleComplete } from '../../lib/field-filters'
import type { AppAction, AppState } from '../../types'
import { Pagination } from '../Pagination'
import { ResultDetail } from '../search/ResultDetail'
import { Button } from '../ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet'
import { Skeleton } from '../ui/skeleton'
import { buildDocumentColumns, collectFieldPaths, hiddenColumnState } from './columns'
import { DocumentTable } from './DocumentTable'
import { DocumentToolbar } from './DocumentToolbar'
import { FilterPanel } from './FilterPanel'

const SKELETON_ROW_KEYS = Array.from({ length: DOCUMENT_PAGE_SIZE }, (_, index) => `placeholder-${index}`)
const MAX_SORT_FIELDS = 8

interface DocumentsViewProps {
  backend: NarsilBackend
  state: AppState
  dispatch: Dispatch<AppAction>
}

function getDocumentRowId(row: ListedDocument): string {
  return row.id
}

function toSortRecord(sorting: SortingState): Record<string, 'asc' | 'desc'> | undefined {
  if (sorting.length === 0) return undefined
  const sort: Record<string, 'asc' | 'desc'> = {}
  for (const entry of sorting) sort[entry.id] = entry.desc ? 'desc' : 'asc'
  return sort
}

function describeOrder(sorting: SortingState): string {
  if (sorting.length === 0) return 'document-id order'
  return sorting.map(entry => `${entry.id} ${entry.desc ? 'descending' : 'ascending'}`).join(', then ')
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

function DocumentSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-2">
      {SKELETON_ROW_KEYS.map(key => (
        <Skeleton key={key} className="h-9 rounded-md" />
      ))}
    </div>
  )
}

export function DocumentsView({ backend, state, dispatch }: DocumentsViewProps) {
  const indexName = state.activeIndexName
  const schema = useIndexSchema(backend, indexName)
  const displayFields = useDisplayFields(indexName)

  const [rules, setRules] = useState<FilterRule[]>([])
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false)
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [pageSize, setPageSize] = useState(DOCUMENT_PAGE_SIZE)
  const [selected, setSelected] = useState<ListedDocument | null>(null)
  const [browsedIndex, setBrowsedIndex] = useState(indexName)
  const hiddenVectorIndex = useRef<string | null>(null)

  if (indexName !== browsedIndex) {
    setBrowsedIndex(indexName)
    setRules([])
    setSorting([])
    setColumnVisibility({})
    setSelected(null)
  }

  useEffect(() => {
    if (!indexName || schema.vectorPaths.size === 0) return
    if (hiddenVectorIndex.current === indexName) return
    hiddenVectorIndex.current = indexName
    const defaults = hiddenColumnState(schema.vectorPaths)
    setColumnVisibility(current => ({ ...defaults, ...current }))
  }, [indexName, schema.vectorPaths])

  const filters = useMemo(() => buildFilterExpression(rules, schema.fields), [rules, schema.fields])
  const sort = useMemo(() => toSortRecord(sorting), [sorting])
  const request = useMemo(() => ({ pageSize, filters, sort }), [pageSize, filters, sort])
  const list = useDocumentList(backend, indexName, request)

  const schemaPaths = useMemo(() => schema.leaves.map(leaf => leaf.path), [schema.leaves])
  const fieldPaths = useMemo(() => collectFieldPaths(list.documents, schemaPaths), [list.documents, schemaPaths])
  const columns = useMemo(
    () => buildDocumentColumns(fieldPaths, schema.sortablePaths),
    [fieldPaths, schema.sortablePaths],
  )

  const table = useReactTable({
    data: list.documents,
    columns,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
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

  const activeFilterCount = useMemo(
    () => rules.filter(rule => isRuleComplete(rule, schema.fields)).length,
    [rules, schema.fields],
  )

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
  const first = list.page * pageSize + 1
  const last = list.page * pageSize + list.documents.length
  const totalPages = Math.ceil(list.total / pageSize)
  const selectedTitle = selected ? displayHeading(selected.document, displayFields, selected.id) : ''
  const isFiltered = activeFilterCount > 0

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="mb-1 text-3xl font-bold tracking-tight">Documents</h1>
        {activeIndex ? (
          <p className="text-sm text-muted-foreground">
            Browsing <span className="font-mono font-medium text-foreground">{activeIndex.name}</span> in{' '}
            {describeOrder(sorting)}
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

      <DocumentToolbar
        table={table}
        activeFilterCount={activeFilterCount}
        isFilterPanelOpen={isFilterPanelOpen}
        onFilterPanelToggle={handleFilterPanelToggle}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
      />

      {isFilterPanelOpen ? (
        <div className="mb-4 rounded-lg border bg-card p-4 shadow-xs">
          <FilterPanel fields={schema.fields} rules={rules} onChange={setRules} />
        </div>
      ) : null}

      <div className="mb-3 flex min-h-4 items-center gap-3 text-xs text-muted-foreground">
        {list.documents.length > 0 ? (
          <>
            <span>
              {first.toLocaleString()}-{last.toLocaleString()} of {list.total.toLocaleString()} document
              {list.total === 1 ? '' : 's'}
              {isFiltered ? ' matching' : ''}
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
        <div className="py-12 text-center text-sm text-muted-foreground">
          {isFiltered ? 'No document matches these conditions.' : 'This index holds no documents yet.'}
        </div>
      ) : null}

      {list.error === null && list.documents.length > 0 ? (
        <DocumentTable table={table} isLoading={list.isLoading} onSelect={setSelected} />
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
