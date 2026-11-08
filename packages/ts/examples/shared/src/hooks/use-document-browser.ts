import type { ListParams, ListResult, SortSpec } from '@delali/narsil'
import type { SortingState, VisibilityState } from '@tanstack/react-table'
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  buildFilterExpression,
  type FilterJoin,
  type FilterRule,
  isRuleComplete,
  type SchemaField,
} from '../lib/field-filters'

export const DOCUMENT_PAGE_SIZE = 20
export const DOCUMENT_PAGE_SIZES = [10, 20, 50, 100]

const NO_EXCLUDED_FIELDS: readonly string[] = []

export interface DocumentBrowser {
  params: ListParams
  page: number
  pageSize: number
  sorting: SortingState
  columnVisibility: VisibilityState
  rules: FilterRule[]
  join: FilterJoin
  activeFilterCount: number
  orderDescription: string
  setPage: (page: number) => void
  setPageSize: (pageSize: number) => void
  setSorting: (updater: SortingState | ((current: SortingState) => SortingState)) => void
  setColumnVisibility: (updater: VisibilityState | ((current: VisibilityState) => VisibilityState)) => void
  setRules: (rules: FilterRule[]) => void
  setJoin: (join: FilterJoin) => void
  hideColumns: (paths: ReadonlySet<string>) => void
  recordCursor: (result: ListResult | undefined) => void
}

function toSortSpec(sorting: SortingState): SortSpec | undefined {
  if (sorting.length === 0) return undefined
  const sort: Record<string, 'asc' | 'desc'> = {}
  for (const entry of sorting) sort[entry.id] = entry.desc ? 'desc' : 'asc'
  return sort
}

function describeOrder(sorting: SortingState): string {
  if (sorting.length === 0) return 'document-id order'
  return sorting.map(entry => `${entry.id} ${entry.desc ? 'descending' : 'ascending'}`).join(', then ')
}

/**
 * Holds the table controls for browsing an index: the page, the page size, the
 * column sort, the hidden columns, and the filter rules. It turns them into the
 * parameters a document listing takes, and remembers the cursor each page
 * answered with so the next page can start from it.
 */
export function useDocumentBrowser(
  indexName: string | null,
  fields: SchemaField[],
  excludedFields: readonly string[] = NO_EXCLUDED_FIELDS,
): DocumentBrowser {
  const [page, setPage] = useState(0)
  const [pageSize, setPageSizeState] = useState(DOCUMENT_PAGE_SIZE)
  const [sorting, setSortingState] = useState<SortingState>([])
  const [columnVisibility, setColumnVisibilityState] = useState<VisibilityState>({})
  const [rules, setRulesState] = useState<FilterRule[]>([])
  const [join, setJoinState] = useState<FilterJoin>('and')
  const [browsedIndex, setBrowsedIndex] = useState(indexName)
  const cursors = useRef<Array<string | undefined>>([undefined])

  if (indexName !== browsedIndex) {
    setBrowsedIndex(indexName)
    setPage(0)
    setSortingState([])
    setColumnVisibilityState({})
    setRulesState([])
    setJoinState('and')
    cursors.current = [undefined]
  }

  const filters = useMemo(() => buildFilterExpression(rules, fields, join), [rules, fields, join])
  const sort = useMemo(() => toSortSpec(sorting), [sorting])

  const params = useMemo<ListParams>(() => {
    const listParams: ListParams = { limit: pageSize }
    const cursor = cursors.current[page]
    if (cursor !== undefined) listParams.cursor = cursor
    if (filters !== undefined) listParams.filters = filters
    if (sort !== undefined) listParams.sort = sort
    if (excludedFields.length > 0) listParams.document = { exclude: [...excludedFields] }
    return listParams
  }, [page, pageSize, filters, sort, excludedFields])

  const restart = useCallback(() => {
    cursors.current = [undefined]
    setPage(0)
  }, [])

  const setPageSize = useCallback(
    (next: number) => {
      setPageSizeState(next)
      restart()
    },
    [restart],
  )

  const setSorting = useCallback(
    (updater: SortingState | ((current: SortingState) => SortingState)) => {
      setSortingState(updater)
      restart()
    },
    [restart],
  )

  const setRules = useCallback(
    (next: FilterRule[]) => {
      setRulesState(next)
      restart()
    },
    [restart],
  )

  const setJoin = useCallback(
    (next: FilterJoin) => {
      setJoinState(next)
      restart()
    },
    [restart],
  )

  const hideColumns = useCallback((paths: ReadonlySet<string>) => {
    if (paths.size === 0) return
    setColumnVisibilityState(current => {
      const hidden: VisibilityState = {}
      for (const path of paths) hidden[path] = false
      return { ...hidden, ...current }
    })
  }, [])

  const goToPage = useCallback((next: number) => {
    if (next < 0) return
    if (next > 0 && cursors.current[next] === undefined) return
    setPage(next)
  }, [])

  const recordCursor = useCallback(
    (result: ListResult | undefined) => {
      if (result === undefined) return
      cursors.current[page + 1] = result.cursor ?? undefined
    },
    [page],
  )

  const activeFilterCount = useMemo(() => rules.filter(rule => isRuleComplete(rule, fields)).length, [rules, fields])

  return {
    params,
    page,
    pageSize,
    sorting,
    columnVisibility,
    rules,
    join,
    activeFilterCount,
    orderDescription: describeOrder(sorting),
    setPage: goToPage,
    setPageSize,
    setSorting,
    setColumnVisibility: setColumnVisibilityState,
    setRules,
    setJoin,
    hideColumns,
    recordCursor,
  }
}
