import { useCallback, useState } from 'react'
import { healLinksFn, provisionIndexFn, setLinkFn } from '../lib/actions.functions'
import type { ClusterEvent } from '../lib/cluster-events'
import type { ClusterSnapshot, LinkKind } from '../lib/cluster-types'
import type { ProvisionResult } from '../lib/probe-types'
import { NODES } from '../topology'
import { type StreamState, useClusterStream } from './use-cluster-stream'

export type RunAction = (label: string, action: () => Promise<void>) => void

export interface Dashboard {
  snapshot: ClusterSnapshot | null
  stream: StreamState
  events: ClusterEvent[]
  provision: ProvisionResult | null
  pending: string | null
  error: string | null
  runAction: RunAction
  onProvision: () => void
  onToggleLink: (nodeId: string, kind: LinkKind, enabled: boolean) => void
  onHealLinks: () => void
  onDismissError: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useDashboard(): Dashboard {
  const { snapshot, stream, events } = useClusterStream()
  const [provision, setProvision] = useState<ProvisionResult | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const runAction = useCallback<RunAction>((label, action) => {
    setPending(label)
    setError(null)
    void action()
      .catch(actionError => {
        setError(messageOf(actionError))
      })
      .finally(() => {
        setPending(null)
      })
  }, [])

  const onProvision = useCallback(() => {
    runAction('Creating the index and ingesting the corpus', async () => {
      setProvision(await provisionIndexFn({ data: { nodeId: NODES[0].nodeId } }))
    })
  }, [runAction])

  const onToggleLink = useCallback(
    (nodeId: string, kind: LinkKind, enabled: boolean) => {
      const verb = enabled ? 'Restoring' : 'Cutting'
      runAction(`${verb} the ${kind} link of ${nodeId}`, async () => {
        await setLinkFn({ data: { nodeId, kind, enabled } })
      })
    },
    [runAction],
  )

  const onHealLinks = useCallback(() => {
    runAction('Restoring every link', async () => {
      await healLinksFn()
    })
  }, [runAction])

  const onDismissError = useCallback(() => {
    setError(null)
  }, [])

  return {
    snapshot,
    stream,
    events,
    provision,
    pending,
    error,
    runAction,
    onProvision,
    onToggleLink,
    onHealLinks,
    onDismissError,
  }
}
