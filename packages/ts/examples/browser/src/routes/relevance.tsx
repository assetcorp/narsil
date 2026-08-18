import { useIndexSchema, useIndexWorkspace } from '@delali/narsil-example-shared'
import { RelevanceLab } from '@delali/narsil-example-shared/components/relevance/RelevanceLab'
import { createFileRoute } from '@tanstack/react-router'
import { useDeferredValue, useMemo, useState } from 'react'
import { useWorkerQuery, useWorkerStats } from '#/worker/hooks'

export const Route = createFileRoute('/relevance')({ component: RelevancePage })

const SCORED_RESULT_DEPTH = 50

function RelevancePage() {
  const { activeIndexName } = useIndexWorkspace()
  const stats = useWorkerStats(activeIndexName)
  const schema = useIndexSchema(stats.data)
  const [term, setTerm] = useState('')

  const deferredTerm = useDeferredValue(term)
  const params = useMemo(
    () => ({ term: deferredTerm, limit: SCORED_RESULT_DEPTH, includeScoreComponents: true }),
    [deferredTerm],
  )
  const results = useWorkerQuery(activeIndexName, params, {
    enabled: deferredTerm.trim().length > 0,
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
