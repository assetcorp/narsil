import { useCallback, useState } from 'react'
import { healLinksFn, provisionIndexFn, runReadProbeFn, setLinkFn } from '../lib/actions.functions'
import type { LinkKind } from '../lib/cluster-types'
import type { ProvisionResult, ReadProbeResult } from '../lib/probe-types'
import { NODES } from '../topology'
import { type StreamState, useClusterStream } from './use-cluster-stream'

const DEFAULT_TERM = 'mortgage'

export interface Dashboard {
  snapshot: ReturnType<typeof useClusterStream>['snapshot']
  stream: StreamState
  term: string
  probeNodeId: string
  probe: ReadProbeResult | null
  provision: ProvisionResult | null
  pending: string | null
  error: string | null
  onTermChange: (term: string) => void
  onProbeNodeChange: (nodeId: string) => void
  onRunProbe: () => void
  onProvision: () => void
  onToggleLink: (nodeId: string, kind: LinkKind, enabled: boolean) => void
  onHealLinks: () => void
  onDismissError: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useDashboard(): Dashboard {
  const { snapshot, stream } = useClusterStream()
  const [term, setTerm] = useState(DEFAULT_TERM)
  const [probeNodeId, setProbeNodeId] = useState(NODES[0].nodeId)
  const [probe, setProbe] = useState<ReadProbeResult | null>(null)
  const [provision, setProvision] = useState<ProvisionResult | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (label: string, action: () => Promise<void>): Promise<void> => {
    setPending(label)
    setError(null)
    try {
      await action()
    } catch (actionError) {
      setError(messageOf(actionError))
    } finally {
      setPending(null)
    }
  }, [])

  const onRunProbe = useCallback(() => {
    void run(`Reading through ${probeNodeId}`, async () => {
      setProbe(await runReadProbeFn({ data: { nodeId: probeNodeId, term } }))
    })
  }, [probeNodeId, run, term])

  const onProvision = useCallback(() => {
    void run('Creating the index and ingesting the corpus', async () => {
      setProvision(await provisionIndexFn({ data: { nodeId: NODES[0].nodeId } }))
    })
  }, [run])

  const onToggleLink = useCallback(
    (nodeId: string, kind: LinkKind, enabled: boolean) => {
      const verb = enabled ? 'Restoring' : 'Cutting'
      void run(`${verb} the ${kind} link of ${nodeId}`, async () => {
        await setLinkFn({ data: { nodeId, kind, enabled } })
      })
    },
    [run],
  )

  const onHealLinks = useCallback(() => {
    void run('Restoring every link', async () => {
      await healLinksFn()
    })
  }, [run])

  const onDismissError = useCallback(() => {
    setError(null)
  }, [])

  return {
    snapshot,
    stream,
    term,
    probeNodeId,
    probe,
    provision,
    pending,
    error,
    onTermChange: setTerm,
    onProbeNodeChange: setProbeNodeId,
    onRunProbe,
    onProvision,
    onToggleLink,
    onHealLinks,
    onDismissError,
  }
}
