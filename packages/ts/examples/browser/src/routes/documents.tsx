import { useAppDispatch, useAppState, useBackend } from '@delali/narsil-example-shared'
import { DocumentsView } from '@delali/narsil-example-shared/components/documents/DocumentsView'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/documents')({ component: DocumentsPage })

function DocumentsPage() {
  const backend = useBackend()
  const state = useAppState()
  const dispatch = useAppDispatch()

  return <DocumentsView backend={backend} state={state} dispatch={dispatch} />
}
