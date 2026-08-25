import { Button } from '@delali/narsil-example-shared/ui/button'
import { memo } from 'react'
import type { ClusterSnapshot, LinkKind } from '../lib/cluster-types'
import { cutLinkCountOf, linkOf } from '../lib/cluster-types'
import { NodeRow } from './NodeRow'

interface NodeBoardProps {
  snapshot: ClusterSnapshot
  onToggleLink: (nodeId: string, kind: LinkKind, enabled: boolean) => void
  onHealLinks: () => void
}

export const NodeBoard = memo(function NodeBoard({ snapshot, onToggleLink, onHealLinks }: NodeBoardProps) {
  const cutLinks = cutLinkCountOf(snapshot)

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold tracking-tight">Nodes</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Each row names the partitions that node leads and the copies it follows, so cutting a link moves those
            numbers to another row.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onHealLinks} disabled={cutLinks === 0}>
          {cutLinks === 0 ? 'Every link is up' : `Restore ${cutLinks} cut link${cutLinks === 1 ? '' : 's'}`}
        </Button>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">Node</th>
              <th className="px-3 py-2 text-left font-medium">Registration</th>
              <th className="px-3 py-2 text-left font-medium">Leads</th>
              <th className="px-3 py-2 text-left font-medium">Follows in sync</th>
              <th className="px-3 py-2 text-left font-medium">Catching up</th>
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
                coordinatorLink={linkOf(snapshot, node.nodeId, 'coordinator')}
                replicationLink={linkOf(snapshot, node.nodeId, 'replication')}
                onToggleLink={onToggleLink}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
})
