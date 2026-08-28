import { cn } from '@delali/narsil-example-shared'
import { Button } from '@delali/narsil-example-shared/ui/button'
import { memo, useCallback } from 'react'
import type { ClusterNodeRow, LinkKind, PartitionRow } from '../lib/cluster-types'
import { partitionIdsOf } from '../lib/cluster-types'
import type { LinkControl } from '../lib/controls'

interface NodeRowProps {
  node: ClusterNodeRow
  isController: boolean
  partitions: PartitionRow[]
  coordinatorLink: LinkControl
  replicationLink: LinkControl
  onToggleLink: (nodeId: string, kind: LinkKind, enabled: boolean) => void
}

interface LinkCellProps {
  control: LinkControl
  onToggleLink: (nodeId: string, kind: LinkKind, enabled: boolean) => void
}

function PartitionIds({ ids, className }: { ids: number[]; className?: string }) {
  if (ids.length === 0) {
    return <span className="font-mono text-sm text-muted-foreground/60">None</span>
  }
  return <span className={cn('font-mono text-sm tabular-nums', className)}>{ids.map(id => `p${id}`).join(' ')}</span>
}

function LinkCell({ control, onToggleLink }: LinkCellProps) {
  const { nodeId, kind, linkUp } = control

  const handleClick = useCallback(() => {
    onToggleLink(nodeId, kind, linkUp === false)
  }, [kind, linkUp, nodeId, onToggleLink])

  if (linkUp === null) {
    return (
      <td
        className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground"
        title={control.reason ?? undefined}
      >
        unknown
      </td>
    )
  }

  return (
    <td className="px-3 py-1.5 text-right">
      <Button variant={linkUp ? 'outline' : 'default'} size="sm" disabled={!control.enabled} onClick={handleClick}>
        {linkUp ? 'Cut link' : 'Restore link'}
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
      <td className="px-3 py-1.5">
        <PartitionIds ids={partitionIdsOf(partitions, node.nodeId, 'last-holder')} className="text-destructive" />
      </td>
      <LinkCell control={coordinatorLink} onToggleLink={onToggleLink} />
      <LinkCell control={replicationLink} onToggleLink={onToggleLink} />
    </tr>
  )
})
