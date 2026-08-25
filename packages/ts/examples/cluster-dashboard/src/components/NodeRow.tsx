import { cn } from '@delali/narsil-example-shared'
import { Button } from '@delali/narsil-example-shared/ui/button'
import { memo, useCallback } from 'react'
import type { ClusterNodeRow, LinkKind, LinkRow, PartitionRow } from '../lib/cluster-types'
import { partitionIdsOf } from '../lib/cluster-types'

interface NodeRowProps {
  node: ClusterNodeRow
  isController: boolean
  partitions: PartitionRow[]
  coordinatorLink: LinkRow | undefined
  replicationLink: LinkRow | undefined
  onToggleLink: (nodeId: string, kind: LinkKind, enabled: boolean) => void
}

interface LinkCellProps {
  nodeId: string
  kind: LinkKind
  link: LinkRow | undefined
  onToggleLink: (nodeId: string, kind: LinkKind, enabled: boolean) => void
}

function PartitionIds({ ids, className }: { ids: number[]; className?: string }) {
  if (ids.length === 0) {
    return <span className="font-mono text-sm text-muted-foreground/60">None</span>
  }
  return <span className={cn('font-mono text-sm tabular-nums', className)}>{ids.map(id => `p${id}`).join(' ')}</span>
}

function LinkCell({ nodeId, kind, link, onToggleLink }: LinkCellProps) {
  const enabled = link?.enabled ?? true
  const handleClick = useCallback(() => {
    onToggleLink(nodeId, kind, !enabled)
  }, [enabled, kind, nodeId, onToggleLink])

  return (
    <td className="px-3 py-1.5 text-right">
      <Button variant={enabled ? 'outline' : 'default'} size="sm" onClick={handleClick}>
        {enabled ? 'Cut link' : 'Restore link'}
      </Button>
    </td>
  )
}

export const NodeRow = memo(function NodeRow({
  node,
  isController,
  partitions,
  coordinatorLink,
  replicationLink,
  onToggleLink,
}: NodeRowProps) {
  return (
    <tr className="border-t border-border">
      <td className="px-3 py-1.5 whitespace-nowrap">
        <span className="font-mono text-sm font-bold">{node.nodeId}</span>
        {isController ? (
          <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">controller</span>
        ) : null}
      </td>
      <td
        className={cn(
          'px-3 py-1.5 font-mono text-xs whitespace-nowrap',
          node.registered ? 'text-muted-foreground' : 'text-destructive',
        )}
      >
        {node.registered ? (node.address ?? 'registered') : 'no registration in etcd'}
      </td>
      <td className="px-3 py-1.5">
        <PartitionIds ids={partitionIdsOf(partitions, node.nodeId, 'primary')} />
      </td>
      <td className="px-3 py-1.5">
        <PartitionIds
          ids={partitionIdsOf(partitions, node.nodeId, 'in-sync-replica')}
          className="text-muted-foreground"
        />
      </td>
      <td className="px-3 py-1.5">
        <PartitionIds ids={partitionIdsOf(partitions, node.nodeId, 'lagging-replica')} className="text-chart-3" />
      </td>
      <LinkCell nodeId={node.nodeId} kind="coordinator" link={coordinatorLink} onToggleLink={onToggleLink} />
      <LinkCell nodeId={node.nodeId} kind="replication" link={replicationLink} onToggleLink={onToggleLink} />
    </tr>
  )
})
