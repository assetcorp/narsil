import { createFileRoute } from '@tanstack/react-router'
import { SyncPanel } from '#/components/sync/SyncPanel'

export const Route = createFileRoute('/sync')({ component: SyncPanel })
