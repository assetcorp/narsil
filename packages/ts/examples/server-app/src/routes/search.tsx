import { useQuery, useStats, useSuggest } from '@delali/narsil/react'
import { toSearchRequest, useIndexSchema, useIndexWorkspace, useSearchForm } from '@delali/narsil-example-shared'
import { SearchPlayground } from '@delali/narsil-example-shared/components/search/SearchPlayground'
import { createFileRoute, useSearch } from '@tanstack/react-router'
import { useDeferredValue, useMemo } from 'react'
import { useRefreshOnChange } from '#/lib/index-changes'
import { RERANK_ADAPTER_NAME } from '#/lib/model-names'

export const Route = createFileRoute('/search')({
  component: SearchRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q : undefined,
  }),
})

const SUGGEST_MIN_LENGTH = 2

function SearchRoute() {
  const { q } = useSearch({ from: '/search' })
  return <SearchPage key={q ?? ''} initialTerm={q} />
}

function SearchPage({ initialTerm }: { initialTerm?: string }) {
  const { activeIndexName } = useIndexWorkspace()
  const form = useSearchForm(initialTerm)
  const stats = useStats(activeIndexName ?? '', { enabled: activeIndexName !== null })
  const schema = useIndexSchema(stats.data)

  const values = useDeferredValue(form.values)
  const term = values.term.trim()
  const vectorPaths = useMemo(() => [...schema.vectorPaths], [schema.vectorPaths])
  const vectorField = vectorPaths[0] ?? null
  const request = useMemo(
    () =>
      toSearchRequest(values, {
        vectorField,
        rerankAdapter: RERANK_ADAPTER_NAME,
        rerankFields: schema.searchablePaths,
        excludedFields: vectorPaths,
      }),
    [values, vectorField, vectorPaths, schema.searchablePaths],
  )

  const results = useQuery(activeIndexName ?? '', request.params, {
    enabled: activeIndexName !== null && term.length > 0,
    keepPreviousData: true,
  })
  useRefreshOnChange(results.refresh)
  useRefreshOnChange(stats.refresh)

  const suggestParams = useMemo(() => ({ prefix: term, limit: 8 }), [term])
  const suggestions = useSuggest(activeIndexName ?? '', suggestParams, {
    enabled: activeIndexName !== null && term.length >= SUGGEST_MIN_LENGTH,
    keepPreviousData: true,
  })

  return (
    <SearchPlayground
      form={form}
      schema={schema}
      params={request.params}
      vectorField={vectorField}
      groupTotalField={null}
      result={results.data}
      suggestions={suggestions.data}
      isLoading={results.isFetching}
      isSuggesting={suggestions.isFetching}
      error={results.error}
    />
  )
}
