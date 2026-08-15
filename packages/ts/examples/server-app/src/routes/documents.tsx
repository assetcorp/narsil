import { useDocuments, useStats } from '@delali/narsil/react'
import { useDocumentBrowser, useIndexSchema, useIndexWorkspace } from '@delali/narsil-example-shared'
import { DocumentsView } from '@delali/narsil-example-shared/components/documents/DocumentsView'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import { EMBEDDING_FIELD } from '#/lib/ask/types'

export const Route = createFileRoute('/documents')({ component: DocumentsPage })

const WITHOUT_STORED_VECTOR = { exclude: [EMBEDDING_FIELD] }

function DocumentsPage() {
  const { activeIndexName } = useIndexWorkspace()
  const stats = useStats(activeIndexName ?? '', { enabled: activeIndexName !== null })
  const schema = useIndexSchema(stats.data)
  const browser = useDocumentBrowser(activeIndexName, schema.fields)

  const params = useMemo(() => ({ ...browser.params, document: WITHOUT_STORED_VECTOR }), [browser.params])
  const list = useDocuments(activeIndexName ?? '', params, {
    enabled: activeIndexName !== null,
    keepPreviousData: true,
  })

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
