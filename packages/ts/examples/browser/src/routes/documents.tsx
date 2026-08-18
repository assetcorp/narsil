import { useDocumentBrowser, useIndexSchema, useIndexWorkspace } from '@delali/narsil-example-shared'
import { DocumentsView } from '@delali/narsil-example-shared/components/documents/DocumentsView'
import { createFileRoute } from '@tanstack/react-router'
import { useWorkerDocuments, useWorkerStats } from '#/worker/hooks'

export const Route = createFileRoute('/documents')({ component: DocumentsPage })

function DocumentsPage() {
  const { activeIndexName } = useIndexWorkspace()
  const stats = useWorkerStats(activeIndexName)
  const schema = useIndexSchema(stats.data)
  const browser = useDocumentBrowser(activeIndexName, schema.fields)
  const list = useWorkerDocuments(activeIndexName, browser.params, { keepPreviousData: true })

  return (
    <DocumentsView
      browser={browser}
      schema={schema}
      list={list.data}
      isLoading={list.isLoading}
      isFetching={list.isFetching}
      error={list.error}
    />
  )
}
