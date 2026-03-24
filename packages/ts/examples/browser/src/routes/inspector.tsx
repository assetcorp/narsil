import { createFileRoute } from '@tanstack/react-router'
import { useBackend, useAppState, useAppDispatch } from '@delali/narsil-example-shared'
import { InspectorView } from '@delali/narsil-example-shared/components/inspector/InspectorView'

export const Route = createFileRoute('/inspector')({ component: InspectorPage })

function InspectorPage() {
  const backend = useBackend()
  const state = useAppState()
  const dispatch = useAppDispatch()

  return <InspectorView backend={backend} state={state} dispatch={dispatch} />
}
