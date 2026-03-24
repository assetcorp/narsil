import { createFileRoute } from '@tanstack/react-router'
import { useBackend, useAppState, useAppDispatch } from '@delali/narsil-example-shared'
import { SearchPlayground } from '@delali/narsil-example-shared/components/search/SearchPlayground'

export const Route = createFileRoute('/search')({ component: SearchPage })

function SearchPage() {
  const backend = useBackend()
  const state = useAppState()
  const dispatch = useAppDispatch()

  return <SearchPlayground backend={backend} state={state} dispatch={dispatch} />
}
