import { type Dispatch, useCallback } from 'react'
import type { NarsilBackend } from '../../backend'
import { useSearch } from '../../hooks/use-search'
import type { AppAction, AppState, LoadedIndex } from '../../types'
import { Button } from '../ui/button'
import { AdvancedOptions } from './AdvancedOptions'
import { FacetSidebar } from './FacetSidebar'
import { ResultList } from './ResultList'
import { SearchBar } from './SearchBar'

function IndexButton({
  idx,
  isActive,
  dispatch,
}: {
  idx: LoadedIndex
  isActive: boolean
  dispatch: Dispatch<AppAction>
}) {
  const handleClick = useCallback(() => {
    dispatch({ type: 'SET_ACTIVE_INDEX', payload: idx.name })
  }, [dispatch, idx.name])

  return (
    <Button
      type="button"
      variant={isActive ? 'default' : 'outline'}
      size="xs"
      className="font-mono text-xs"
      onClick={handleClick}
    >
      {idx.name}
    </Button>
  )
}

interface SearchPlaygroundProps {
  backend: NarsilBackend
  state: AppState
  dispatch: Dispatch<AppAction>
  initialTerm?: string
}

function getSearchableFields(state: AppState): string[] {
  const activeIndex = state.indexes.find(i => i.name === state.activeIndexName)
  if (!activeIndex) return []

  switch (activeIndex.datasetId) {
    case 'tmdb':
      return ['title', 'overview', 'tagline']
    case 'wikipedia':
      return ['title', 'text']
    case 'cranfield':
      return ['title', 'body']
    default:
      return []
  }
}

function getAllFields(state: AppState): string[] {
  const activeIndex = state.indexes.find(i => i.name === state.activeIndexName)
  if (!activeIndex) return []

  switch (activeIndex.datasetId) {
    case 'tmdb':
      return [
        'title',
        'overview',
        'tagline',
        'genres',
        'original_language',
        'vote_average',
        'popularity',
        'runtime',
        'revenue',
        'release_year',
        'production_countries',
        'status',
      ]
    case 'wikipedia':
      return ['title', 'text', 'language', 'categories']
    case 'cranfield':
      return ['title', 'author', 'body']
    default:
      return []
  }
}

export function SearchPlayground({ backend, state, dispatch, initialTerm }: SearchPlaygroundProps) {
  const indexName = state.activeIndexName
  const searchableFields = getSearchableFields(state)
  const allFields = getAllFields(state)
  const search = useSearch(backend, indexName, initialTerm)

  if (!indexName) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-2 font-serif text-3xl tracking-tight">Search Playground</h1>
        <p className="text-sm text-muted-foreground">Load a dataset from the Datasets tab to start searching.</p>
      </div>
    )
  }

  const activeIndex = state.indexes.find(i => i.name === indexName)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="mb-1 font-serif text-3xl tracking-tight">Search Playground</h1>
        {activeIndex && (
          <p className="text-sm text-muted-foreground">
            Searching <span className="font-mono font-medium text-foreground">{activeIndex.name}</span> (
            {activeIndex.documentCount.toLocaleString()} documents)
          </p>
        )}
      </div>

      {state.indexes.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {state.indexes.map(idx => (
            <IndexButton key={idx.name} idx={idx} isActive={idx.name === indexName} dispatch={dispatch} />
          ))}
        </div>
      )}

      <SearchBar
        term={search.params.term}
        onTermChange={search.setTerm}
        resultCount={search.results?.count ?? null}
        elapsed={search.results?.elapsed ?? null}
        isLoading={search.isLoading}
        suggestions={search.suggestions}
      />

      <AdvancedOptions
        params={search.params}
        searchableFields={searchableFields}
        allFields={allFields}
        onFieldsChange={search.setFields}
        onBoostChange={search.setBoost}
        onSortChange={search.setSort}
        onParamChange={search.updateParam}
      />

      <div className="mt-6 flex gap-6">
        {search.results?.facets && Object.keys(search.results.facets).length > 0 && (
          <aside className="hidden w-56 shrink-0 lg:block">
            <FacetSidebar
              facets={search.results.facets}
              filters={search.params.filters as Record<string, { fields?: Record<string, { in?: string[] }> }>}
              onFilterChange={search.setFilter}
            />
          </aside>
        )}

        <div className="min-w-0 flex-1">
          <ResultList
            hits={search.results?.hits ?? []}
            isLoading={search.isLoading}
            error={search.error}
            count={search.results?.count ?? 0}
            limit={search.params.limit}
            offset={search.params.offset}
            cursor={search.results?.cursor}
            paginationMode={search.params.paginationMode}
            onPageChange={search.setPage}
            onLoadMore={search.loadMore}
            datasetId={activeIndex?.datasetId ?? 'tmdb'}
          />
        </div>
      </div>
    </div>
  )
}
