import { createFileRoute, useSearch } from '@tanstack/react-router'
import { SyncPanel } from '#/components/sync/SyncPanel'

export const Route = createFileRoute('/sync')({
  component: SyncRoute,
  validateSearch: (search: Record<string, unknown>): { device?: string } =>
    typeof search.device === 'string' ? { device: search.device } : {},
})

function SyncRoute() {
  const { device } = useSearch({ from: '/sync' })
  return <SyncPanel device={device} />
}
