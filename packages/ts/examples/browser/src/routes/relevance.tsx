import {
  type BM25Config,
  DEFAULT_BM25_CONFIG,
  relevanceParams,
  useIndexSchema,
  useIndexWorkspace,
} from '@delali/narsil-example-shared'
import { RelevanceLab } from '@delali/narsil-example-shared/components/relevance/RelevanceLab'
import { createFileRoute } from '@tanstack/react-router'
import { useDeferredValue, useMemo, useState } from 'react'
import { useWorkerQuery, useWorkerStats } from '#/worker/hooks'

export const Route = createFileRoute('/relevance')({ component: RelevancePage })

function RelevancePage() {
  const { activeIndexName } = useIndexWorkspace()
  const stats = useWorkerStats(activeIndexName)
  const schema = useIndexSchema(stats.data)
  const [term, setTerm] = useState('')
  const [config, setConfig] = useState<BM25Config>(DEFAULT_BM25_CONFIG)

  const deferredTerm = useDeferredValue(term)
  const deferredConfig = useDeferredValue(config)
  const excludedFields = useMemo(() => [...schema.vectorPaths], [schema.vectorPaths])
  const enabled = deferredTerm.trim().length > 0
  const params = useMemo(() => relevanceParams(deferredTerm, excludedFields, null), [deferredTerm, excludedFields])
  const tunedParams = useMemo(
    () => relevanceParams(deferredTerm, excludedFields, deferredConfig),
    [deferredTerm, excludedFields, deferredConfig],
  )
  const results = useWorkerQuery(activeIndexName, params, { enabled, keepPreviousData: true })
  const tuned = useWorkerQuery(activeIndexName, tunedParams, { enabled, keepPreviousData: true })

  return (
    <RelevanceLab
      schema={schema}
      term={term}
      onTermChange={setTerm}
      config={config}
      onConfigChange={setConfig}
      result={results.data}
      tunedResult={tuned.data}
      isLoading={results.isFetching || tuned.isFetching}
      error={results.error ?? tuned.error}
    />
  )
}
