import { Button } from '@delali/narsil-example-shared/ui/button'
import { memo } from 'react'
import { type DashboardControls, localReasonOf } from '../lib/controls'
import type { ProvisionResult } from '../lib/probe-types'
import { PARTITION_COUNT, REPLICATION_FACTOR } from '../topology'

interface SetupPanelProps {
  indexName: string
  indexExists: boolean
  provision: ProvisionResult | null
  controls: DashboardControls
  onProvision: () => void
}

export const SetupPanel = memo(function SetupPanel({
  indexName,
  indexExists,
  provision,
  controls,
  onProvision,
}: SetupPanelProps) {
  const reason = localReasonOf(controls.provision, controls.blockedReason)

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card p-5">
      <h2 className="text-sm font-bold tracking-tight">Corpus</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Creating the index spreads {PARTITION_COUNT} partitions over the three nodes, each with a primary and{' '}
        {REPLICATION_FACTOR} copy, so every node leads some partitions and follows others.
      </p>

      <dl className="mt-4 flex flex-col gap-2 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Index</dt>
          <dd className="font-mono">{indexName}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Allocated</dt>
          <dd className="font-mono">{indexExists ? 'yes' : 'not yet'}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Ingest through</dt>
          <dd className="font-mono">{controls.provision.nodeId ?? 'no registered node'}</dd>
        </div>
      </dl>

      {provision === null ? null : (
        <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">{provision.message}</p>
      )}

      <Button className="mt-4 w-full" onClick={onProvision} disabled={!controls.provision.enabled}>
        {indexExists ? 'Ingest again' : 'Create and ingest'}
      </Button>

      {reason === null ? null : <p className="mt-2 text-xs text-destructive">{reason}</p>}
    </section>
  )
})
