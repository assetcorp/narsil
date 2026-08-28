import { Button } from '@delali/narsil-example-shared/ui/button'
import { memo } from 'react'
import type { ClusterSnapshot } from '../lib/cluster-types'
import { cutLinkCountOf } from '../lib/cluster-types'
import { type DashboardControls, linkControlOf, localReasonOf } from '../lib/controls'
import { NodeRow } from './NodeRow'

interface NodeBoardProps {
  snapshot: ClusterSnapshot
  controls: DashboardControls
  onToggleLink: (nodeId: string, kind: 'coordinator' | 'replication', enabled: boolean) => void
  onHealLinks: () => void
}

function healLabelOf(snapshot: ClusterSnapshot, cutLinks: number): string {
  if (snapshot.faultInjectorError !== null) {
    return 'No link state to show'
  }
  if (cutLinks === 0) {
    return 'Every link is up'
  }
  return `Restore ${cutLinks} cut link${cutLinks === 1 ? '' : 's'}`
}

export const NodeBoard = memo(function NodeBoard({ snapshot, controls, onToggleLink, onHealLinks }: NodeBoardProps) {
  const cutLinks = cutLinkCountOf(snapshot)
  const healReason = localReasonOf(controls.heal, controls.blockedReason)

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold tracking-tight">Nodes</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Each row names the partitions that node leads and the copies it follows, so cutting a link moves those
            numbers to another row. The last column names the partitions no node serves whose data this node still
            holds, which is what the controller gives one of them back from.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onHealLinks} disabled={!controls.heal.enabled}>
          {healLabelOf(snapshot, cutLinks)}
        </Button>
      </div>

      {healReason === null ? null : <p className="mt-3 text-sm text-destructive">{healReason}</p>}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">Node</th>
              <th className="px-3 py-2 text-left font-medium">Registration</th>
              <th className="px-3 py-2 text-left font-medium">Leads</th>
              <th className="px-3 py-2 text-left font-medium">Follows in sync</th>
              <th className="px-3 py-2 text-left font-medium">Catching up</th>
              <th className="px-3 py-2 text-left font-medium">Holds unserved</th>
              <th className="px-3 py-2 text-right font-medium">Coordinator</th>
              <th className="px-3 py-2 text-right font-medium">Replication</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.nodes.map(node => (
              <NodeRow
                key={node.nodeId}
                node={node}
                isController={snapshot.controllerNodeId === node.nodeId}
                partitions={snapshot.partitions}
                coordinatorLink={linkControlOf(snapshot, controls.blockedReason, node.nodeId, 'coordinator')}
                replicationLink={linkControlOf(snapshot, controls.blockedReason, node.nodeId, 'replication')}
                onToggleLink={onToggleLink}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
})
