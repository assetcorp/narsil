import { useStats } from '@delali/narsil/react'
import { useIndexSchema, useIndexWorkspace } from '@delali/narsil-example-shared'
import { MapView } from '@delali/narsil-example-shared/components/map/MapView'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/map')({ component: MapPage })

function MapPage() {
  const { activeIndexName } = useIndexWorkspace()
  const stats = useStats(activeIndexName ?? '', { enabled: activeIndexName !== null })
  const schema = useIndexSchema(stats.data)
  return <MapView schema={schema} />
}
