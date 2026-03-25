import { useAppDispatch, useAppState, useBackend } from '@delali/narsil-example-shared'
import { SearchPlayground } from '@delali/narsil-example-shared/components/search/SearchPlayground'
import { createFileRoute, useSearch } from '@tanstack/react-router'

export const Route = createFileRoute('/search')({
  component: SearchPage,
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === 'string' ? search.q : undefined,
  }),
})

function SearchPage() {
  const backend = useBackend()
  const state = useAppState()
  const dispatch = useAppDispatch()
  const { q } = useSearch({ from: '/search' })

  return <SearchPlayground backend={backend} state={state} dispatch={dispatch} initialTerm={q} />
}
