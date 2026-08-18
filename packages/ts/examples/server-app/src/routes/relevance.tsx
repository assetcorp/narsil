import { useQuery, useStats } from '@delali/narsil/react'
import { useIndexSchema, useIndexWorkspace } from '@delali/narsil-example-shared'
import { RelevanceLab } from '@delali/narsil-example-shared/components/relevance/RelevanceLab'
import { createFileRoute } from '@tanstack/react-router'
import { useDeferredValue, useMemo, useState } from 'react'
import { EMBEDDING_FIELD } from '#/lib/ask/types'

export const Route = createFileRoute('/relevance')({ component: RelevancePage })

const SCORED_RESULT_DEPTH = 50
const WITHOUT_STORED_VECTOR = { exclude: [EMBEDDING_FIELD] }

function RelevancePage() {
  const { activeIndexName } = useIndexWorkspace()
  const stats = useStats(activeIndexName ?? '', { enabled: activeIndexName !== null })
  const schema = useIndexSchema(stats.data)
  const [term, setTerm] = useState('')

  const deferredTerm = useDeferredValue(term)
  const params = useMemo(
    () => ({
      term: deferredTerm,
      limit: SCORED_RESULT_DEPTH,
      includeScoreComponents: true,
      document: WITHOUT_STORED_VECTOR,
    }),
    [deferredTerm],
  )
  const results = useQuery(activeIndexName ?? '', params, {
    enabled: activeIndexName !== null && deferredTerm.trim().length > 0,
    keepPreviousData: true,
  })

  return (
    <RelevanceLab
      schema={schema}
      term={term}
      onTermChange={setTerm}
      result={results.data}
      isLoading={results.isFetching}
      error={results.error}
    />
  )
}
