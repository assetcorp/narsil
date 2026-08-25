import { Button } from '@delali/narsil-example-shared/ui/button'
import type { ClusterSnapshot, LinkKind } from '../lib/cluster-types'
import { cutLinkCountOf, linkOf } from '../lib/cluster-types'
import { NodeColumn } from './NodeColumn'

interface NodeBoardProps {
  snapshot: ClusterSnapshot
  onToggleLink: (nodeId: string, kind: LinkKind, enabled: boolean) => void
  onHealLinks: () => void
}

export function NodeBoard({ snapshot, onToggleLink, onHealLinks }: NodeBoardProps) {
  const cutLinks = cutLinkCountOf(snapshot)

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold tracking-tight">Nodes</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            A filled chip marks a partition the node leads, an outlined chip marks a copy that keeps up with its
            primary, and a dashed chip marks a copy that is still catching up. Cut a link and watch the chips move.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onHealLinks} disabled={cutLinks === 0}>
          {cutLinks === 0 ? 'Every link is up' : `Restore ${cutLinks} cut link${cutLinks === 1 ? '' : 's'}`}
        </Button>
      </div>

      <div className="mt-5 grid gap-6 md:grid-cols-3">
        {snapshot.nodes.map(node => (
          <NodeColumn
            key={node.nodeId}
            node={node}
            isController={snapshot.controllerNodeId === node.nodeId}
            partitions={snapshot.partitions}
            coordinatorLink={linkOf(snapshot, node.nodeId, 'coordinator')}
            replicationLink={linkOf(snapshot, node.nodeId, 'replication')}
            onToggleLink={onToggleLink}
          />
        ))}
      </div>
    </section>
  )
}
