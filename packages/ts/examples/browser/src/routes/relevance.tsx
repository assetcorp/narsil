import { createFileRoute } from '@tanstack/react-router'
import { useBackend, useAppState, useAppDispatch } from '@delali/narsil-example-shared'
import { RelevanceLab } from '@delali/narsil-example-shared/components/relevance/RelevanceLab'

export const Route = createFileRoute('/relevance')({ component: RelevancePage })

function RelevancePage() {
  const backend = useBackend()
  const state = useAppState()
  const dispatch = useAppDispatch()

  return <RelevanceLab backend={backend} state={state} dispatch={dispatch} />
}
