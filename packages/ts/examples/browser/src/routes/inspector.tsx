import { useIndexWorkspace } from '@delali/narsil-example-shared'
import { InspectorView } from '@delali/narsil-example-shared/components/inspector/InspectorView'
import { createFileRoute } from '@tanstack/react-router'
import { useWorkerMemory, useWorkerPartitions, useWorkerStats, useWorkerVectorFields } from '#/worker/hooks'

export const Route = createFileRoute('/inspector')({ component: InspectorPage })

function InspectorPage() {
  const { activeIndexName } = useIndexWorkspace()
  const stats = useWorkerStats(activeIndexName)
  const partitions = useWorkerPartitions(activeIndexName)
  const vectorFields = useWorkerVectorFields(activeIndexName)
  const memory = useWorkerMemory(activeIndexName !== null)

  return (
    <InspectorView
      stats={stats.data}
      partitions={partitions.data}
      vectorFields={vectorFields.data}
      memory={memory.data}
      isLoading={stats.isLoading}
    />
  )
}
