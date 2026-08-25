import { cn } from '@delali/narsil-example-shared'
import { Button } from '@delali/narsil-example-shared/ui/button'
import { useCallback } from 'react'
import type { ClusterNodeRow, LinkKind, LinkRow, PartitionRole, PartitionRow } from '../lib/cluster-types'
import { partitionRoleOf, tallyOf } from '../lib/cluster-types'

interface NodeColumnProps {
  node: ClusterNodeRow
  isController: boolean
  partitions: PartitionRow[]
  coordinatorLink: LinkRow | undefined
  replicationLink: LinkRow | undefined
  onToggleLink: (nodeId: string, kind: LinkKind, enabled: boolean) => void
}

const CHIP_CLASS: Record<Exclude<PartitionRole, 'absent'>, string> = {
  primary: 'border-foreground bg-foreground text-background',
  'in-sync-replica': 'border-border bg-card text-muted-foreground',
  'lagging-replica': 'border-dashed border-chart-3 bg-card text-chart-3',
}

function PartitionChip({ partition, nodeId }: { partition: PartitionRow; nodeId: string }) {
  const role = partitionRoleOf(partition, nodeId)
  if (role === 'absent') {
    return null
  }
  const label = role === 'primary' ? 'leads' : role === 'in-sync-replica' ? 'follows in sync' : 'catching up'
  return (
    <span
      className={cn('rounded border px-1.5 py-0.5 font-mono text-[11px] tabular-nums', CHIP_CLASS[role])}
      title={`${nodeId} ${label} partition ${partition.partitionId}`}
    >
      p{partition.partitionId}
    </span>
  )
}

interface LinkButtonProps {
  label: string
  nodeId: string
  kind: LinkKind
  link: LinkRow | undefined
  onToggleLink: (nodeId: string, kind: LinkKind, enabled: boolean) => void
}

function LinkButton({ label, nodeId, kind, link, onToggleLink }: LinkButtonProps) {
  const enabled = link?.enabled ?? true
  const handleClick = useCallback(() => {
    onToggleLink(nodeId, kind, !enabled)
  }, [enabled, kind, nodeId, onToggleLink])

  return (
    <Button
      variant={enabled ? 'outline' : 'secondary'}
      size="sm"
      className={cn('justify-between font-mono text-[11px]', !enabled && 'text-destructive')}
      onClick={handleClick}
    >
      <span>{label}</span>
      <span className="uppercase tracking-wider">{enabled ? 'cut' : 'restore'}</span>
    </Button>
  )
}

export function NodeColumn({
  node,
  isController,
  partitions,
  coordinatorLink,
  replicationLink,
  onToggleLink,
}: NodeColumnProps) {
  const tally = tallyOf(partitions, node.nodeId)
  const accent = !node.registered ? 'bg-destructive' : tally.lagging > 0 ? 'bg-chart-3' : 'bg-border'
  const held = partitions.filter(partition => partitionRoleOf(partition, node.nodeId) !== 'absent')

  return (
    <section className="flex gap-3">
      <span aria-hidden="true" className={cn('w-0.5 shrink-0 rounded-full', accent)} />

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="font-mono text-sm font-bold">{node.nodeId}</h3>
          {isController ? (
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">controller</span>
          ) : null}
        </div>

        <p className={cn('font-mono text-xs', node.registered ? 'text-muted-foreground' : 'text-destructive')}>
          {node.registered ? (node.address ?? 'registered') : 'no registration in etcd'}
        </p>

        <dl className="flex gap-4 font-mono text-xs tabular-nums">
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">leads</dt>
            <dd className="text-sm">{tally.leads}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">follows</dt>
            <dd className="text-sm">{tally.inSync}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">catching up</dt>
            <dd className={cn('text-sm', tally.lagging > 0 && 'text-chart-3')}>{tally.lagging}</dd>
          </div>
        </dl>

        <div className="flex min-h-8 flex-wrap gap-1">
          {held.length === 0 ? (
            <span className="font-mono text-[11px] text-muted-foreground">holds no partition</span>
          ) : (
            held.map(partition => (
              <PartitionChip key={partition.partitionId} partition={partition} nodeId={node.nodeId} />
            ))
          )}
        </div>

        <div className="mt-auto grid gap-1.5 border-t border-border pt-3">
          <LinkButton
            label="coordinator"
            nodeId={node.nodeId}
            kind="coordinator"
            link={coordinatorLink}
            onToggleLink={onToggleLink}
          />
          <LinkButton
            label="replication"
            nodeId={node.nodeId}
            kind="replication"
            link={replicationLink}
            onToggleLink={onToggleLink}
          />
        </div>
      </div>
    </section>
  )
}
