import { useAppDispatch, useAppState, useBackend } from '@delali/narsil-example-shared'
import { InspectorView } from '@delali/narsil-example-shared/components/inspector/InspectorView'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/inspector')({ component: InspectorPage })

function InspectorPage() {
  const backend = useBackend()
  const state = useAppState()
  const dispatch = useAppDispatch()

  return <InspectorView backend={backend} state={state} dispatch={dispatch} />
}
