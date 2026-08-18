import type { FilterExpression, QueryResult, SuggestResult } from '@delali/narsil'
import { SlidersHorizontal } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useDisplayFields } from '../../hooks/use-display-fields'
import type { IndexSchemaView } from '../../hooks/use-index-schema'
import type { SearchForm } from '../../hooks/use-search-form'
import { useActiveIndex, useIndexWorkspace } from '../../workspace'
import { IndexSelector } from '../IndexSelector'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '../ui/sheet'
import { AdvancedOptions } from './AdvancedOptions'
import { FacetSidebar } from './FacetSidebar'
import { ResultList } from './ResultList'
import { SearchBar } from './SearchBar'

function countActiveFilters(filters: FilterExpression): number {
  const fields = filters.fields
  if (!fields) return 0
  return Object.values(fields).reduce((total, field) => {
    const inValues = (field as { in?: string[] }).in
    return total + (inValues?.length ?? 0)
  }, 0)
}

interface FacetSheetProps {
  facets: NonNullable<QueryResult['facets']>
  filters: FilterExpression
  onFilterChange: (filters: FilterExpression) => void
}

function FacetSheet({ facets, filters, onFilterChange }: FacetSheetProps) {
  const [open, setOpen] = useState(false)
  const activeCount = countActiveFilters(filters)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="lg:hidden">
          <SlidersHorizontal className="size-3.5" />
          Filters
          {activeCount > 0 ? (
            <Badge variant="secondary" className="text-[10px]">
              {activeCount}
            </Badge>
          ) : null}
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 gap-0">
        <SheetHeader className="border-b">
          <SheetTitle className="text-sm">Filters</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <FacetSidebar facets={facets} filters={filters} onFilterChange={onFilterChange} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

export interface SearchPlaygroundProps {
  form: SearchForm
  schema: IndexSchemaView
  result: QueryResult | undefined
  suggestions: SuggestResult | undefined
  isLoading: boolean
  isSuggesting: boolean
  error: Error | undefined
}

export function SearchPlayground({
  form,
  schema,
  result,
  suggestions,
  isLoading,
  isSuggesting,
  error,
}: SearchPlaygroundProps) {
  const { activeIndexName } = useIndexWorkspace()
  const activeIndex = useActiveIndex()
  const displayFields = useDisplayFields(activeIndexName)
  const sortableFields = useMemo(() => [...schema.sortablePaths], [schema.sortablePaths])
  const cursor = result?.cursor

  const handleLoadMore = useCallback(() => {
    form.loadMore(cursor)
  }, [form, cursor])

  if (activeIndexName === null) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Search Playground</h1>
        <p className="text-sm text-muted-foreground">Load a dataset from the Datasets tab to start searching.</p>
      </div>
    )
  }

  const facets = result?.facets
  const hasFacets = facets !== undefined && Object.keys(facets).length > 0

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="mb-1 text-3xl font-bold tracking-tight">Search Playground</h1>
        {activeIndex ? (
          <p className="text-sm text-muted-foreground">
            Searching <span className="font-mono font-medium text-foreground">{activeIndex.name}</span> (
            {activeIndex.documentCount.toLocaleString()} documents)
          </p>
        ) : null}
      </div>

      <IndexSelector />

      <SearchBar
        term={form.values.term}
        onTermChange={form.setTerm}
        resultCount={result?.count ?? null}
        elapsed={result?.elapsed ?? null}
        isLoading={isLoading || isSuggesting}
        suggestions={suggestions ?? null}
      />

      <AdvancedOptions
        values={form.values}
        searchableFields={schema.searchablePaths}
        sortableFields={sortableFields}
        onFieldsChange={form.setFields}
        onBoostChange={form.setBoost}
        onSortChange={form.setSort}
        onValueChange={form.setValue}
      />

      <div className="mt-6 flex gap-6">
        {hasFacets ? (
          <aside className="hidden w-56 shrink-0 lg:block">
            <FacetSidebar facets={facets} filters={form.values.filters} onFilterChange={form.setFilters} />
          </aside>
        ) : null}

        <div className="min-w-0 flex-1">
          {hasFacets ? (
            <div className="mb-3 lg:hidden">
              <FacetSheet facets={facets} filters={form.values.filters} onFilterChange={form.setFilters} />
            </div>
          ) : null}
          <ResultList
            hits={result?.hits ?? []}
            isLoading={isLoading}
            error={error?.message ?? null}
            count={result?.count ?? 0}
            limit={form.values.limit}
            offset={form.values.offset}
            cursor={cursor}
            paginationMode={form.values.paginationMode}
            onPageChange={form.setPage}
            onLoadMore={handleLoadMore}
            datasetId={activeIndex?.datasetId ?? 'custom'}
            displayFields={displayFields}
          />
        </div>
      </div>
    </div>
  )
}
