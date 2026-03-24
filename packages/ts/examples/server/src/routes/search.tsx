import { useAppDispatch, useAppState, useBackend } from '@delali/narsil-example-shared'
import { SearchPlayground } from '@delali/narsil-example-shared/components/search/SearchPlayground'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/search')({ component: SearchPage })

function SearchPage() {
  const backend = useBackend()
  const state = useAppState()
  const dispatch = useAppDispatch()

  return <SearchPlayground backend={backend} state={state} dispatch={dispatch} />
}
