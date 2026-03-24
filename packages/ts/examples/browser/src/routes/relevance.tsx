import { useAppDispatch, useAppState, useBackend } from '@delali/narsil-example-shared'
import { RelevanceLab } from '@delali/narsil-example-shared/components/relevance/RelevanceLab'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/relevance')({ component: RelevancePage })

function RelevancePage() {
  const backend = useBackend()
  const state = useAppState()
  const dispatch = useAppDispatch()

  return <RelevanceLab backend={backend} state={state} dispatch={dispatch} />
}
