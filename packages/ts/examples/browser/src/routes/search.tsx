import { toQueryParams, useIndexSchema, useIndexWorkspace, useSearchForm } from '@delali/narsil-example-shared'
import { SearchPlayground } from '@delali/narsil-example-shared/components/search/SearchPlayground'
import { createFileRoute, useSearch } from '@tanstack/react-router'
import { useDeferredValue, useMemo } from 'react'
import { useWorkerQuery, useWorkerStats, useWorkerSuggest } from '#/worker/hooks'

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
  const stats = useWorkerStats(activeIndexName)
  const schema = useIndexSchema(stats.data)

  const values = useDeferredValue(form.values)
  const params = useMemo(() => toQueryParams(values), [values])
  const term = values.term.trim()

  const results = useWorkerQuery(activeIndexName, params, { enabled: term.length > 0, keepPreviousData: true })

  const suggestParams = useMemo(() => ({ prefix: term, limit: 8 }), [term])
  const suggestions = useWorkerSuggest(activeIndexName, suggestParams, {
    enabled: term.length >= SUGGEST_MIN_LENGTH,
    keepPreviousData: true,
  })

  return (
    <SearchPlayground
      form={form}
      schema={schema}
      result={results.data}
      suggestions={suggestions.data}
      isLoading={results.isFetching}
      isSuggesting={suggestions.isFetching}
      error={results.error}
    />
  )
}
