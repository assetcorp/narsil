import { useCallback, useMemo, useState } from 'react'
import { healLinksFn, provisionIndexFn, setLinkFn } from '../lib/actions.functions'
import type { ClusterEvent } from '../lib/cluster-events'
import type { ClusterSnapshot, LinkKind, StreamState } from '../lib/cluster-types'
import { buildControls, type DashboardControls } from '../lib/controls'
import type { ProvisionResult } from '../lib/probe-types'
import { useClusterStream } from './use-cluster-stream'

export type RunAction = (label: string, action: () => Promise<void>) => void

export interface Dashboard {
  snapshot: ClusterSnapshot | null
  stream: StreamState
  streamError: string | null
  events: ClusterEvent[]
  controls: DashboardControls | null
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
  const { snapshot, stream, streamError, events } = useClusterStream()
  const [provision, setProvision] = useState<ProvisionResult | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const controls = useMemo(
    () => (snapshot === null ? null : buildControls(snapshot, stream, pending)),
    [pending, snapshot, stream],
  )

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

  const provisionNodeId = controls?.provision.enabled === true ? controls.provision.nodeId : null

  const onProvision = useCallback(() => {
    if (provisionNodeId === null) {
      return
    }
    runAction(`Creating the index and ingesting the corpus through ${provisionNodeId}`, async () => {
      setProvision(await provisionIndexFn({ data: { nodeId: provisionNodeId } }))
    })
  }, [provisionNodeId, runAction])

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
    streamError,
    events,
    controls,
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
