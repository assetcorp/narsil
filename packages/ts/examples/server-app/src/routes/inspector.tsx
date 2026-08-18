import type { MemoryStats, PartitionStatsResult, VectorMaintenanceResult } from '@delali/narsil'
import { useNarsilClient, useStats } from '@delali/narsil/react'
import { useIndexWorkspace } from '@delali/narsil-example-shared'
import { InspectorView } from '@delali/narsil-example-shared/components/inspector/InspectorView'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

export const Route = createFileRoute('/inspector')({ component: InspectorPage })

interface InspectorDetail {
  partitions: PartitionStatsResult[]
  vectorFields: VectorMaintenanceResult[]
  memory: MemoryStats | undefined
}

function InspectorPage() {
  const { activeIndexName } = useIndexWorkspace()
  const client = useNarsilClient()
  const stats = useStats(activeIndexName ?? '', { enabled: activeIndexName !== null })
  const [detail, setDetail] = useState<InspectorDetail | undefined>(undefined)

  useEffect(() => {
    if (activeIndexName === null) {
      setDetail(undefined)
      return
    }

    const controller = new AbortController()
    const options = { signal: controller.signal }
    Promise.all([
      client.getPartitionStats(activeIndexName, options),
      client.vectorMaintenanceStatus(activeIndexName, options),
      client.getMemoryStats(options).catch(() => undefined),
    ])
      .then(([partitions, vectorFields, memory]) => {
        if (controller.signal.aborted) return
        setDetail({ partitions, vectorFields, memory })
      })
      .catch(() => {
        if (!controller.signal.aborted) setDetail(undefined)
      })

    return () => {
      controller.abort()
    }
  }, [client, activeIndexName])

  return (
    <InspectorView
      stats={stats.data}
      partitions={detail?.partitions}
      vectorFields={detail?.vectorFields}
      memory={detail?.memory}
      isLoading={stats.isLoading}
    />
  )
}
