import { useIndexSchema, useIndexWorkspace } from '@delali/narsil-example-shared'
import { MapView } from '@delali/narsil-example-shared/components/map/MapView'
import { createFileRoute } from '@tanstack/react-router'
import { useWorkerStats } from '#/worker/hooks'

export const Route = createFileRoute('/map')({ component: MapPage })

function MapPage() {
  const { activeIndexName } = useIndexWorkspace()
  const stats = useWorkerStats(activeIndexName)
  const schema = useIndexSchema(stats.data)
  return <MapView schema={schema} />
}
