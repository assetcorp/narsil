import { cn } from '@delali/narsil-example-shared'
import type { ClusterSnapshot, PartitionRow } from '../lib/cluster-types'
import { copyCountOf } from '../lib/cluster-types'

const STATE_CLASS: Record<string, string> = {
  ACTIVE: 'text-foreground',
  INITIALISING: 'text-chart-3',
  MIGRATING: 'text-chart-3',
  DECOMMISSIONING: 'text-muted-foreground',
  UNASSIGNED: 'text-destructive',
}

interface PartitionTableProps {
  snapshot: ClusterSnapshot
}

function PartitionRowView({ partition, replicationFactor }: { partition: PartitionRow; replicationFactor: number }) {
  const copies = copyCountOf(partition)
  const copyTarget = replicationFactor + 1
  const inSync = partition.inSyncSet.length

  return (
    <tr className="border-t border-border">
      <td className="px-3 py-2 font-mono text-sm tabular-nums">p{partition.partitionId}</td>
      <td className={cn('px-3 py-2 font-mono text-xs', STATE_CLASS[partition.state] ?? 'text-foreground')}>
        {partition.state.toLowerCase()}
      </td>
      <td className="px-3 py-2 font-mono text-sm">{partition.primary ?? 'none'}</td>
      <td className="px-3 py-2 text-right font-mono text-sm tabular-nums">{partition.primaryTerm}</td>
      <td className={cn('px-3 py-2 text-right font-mono text-sm tabular-nums', copies < copyTarget && 'text-chart-3')}>
        {copies}/{copyTarget}
      </td>
      <td
        className={cn(
          'px-3 py-2 text-right font-mono text-sm tabular-nums',
          inSync < replicationFactor && 'text-chart-3',
        )}
      >
        {inSync}/{replicationFactor}
      </td>
      <td className="px-3 py-2 text-right font-mono text-sm tabular-nums text-muted-foreground">
        {partition.commitPoint}
      </td>
    </tr>
  )
}

export function PartitionTable({ snapshot }: PartitionTableProps) {
  const replicationFactor = snapshot.replicationFactor ?? 0

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold tracking-tight">Partitions</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Each partition keeps its own primary, its own in-sync set, and its own commit point, so a failover raises
            the term on the rows it touches and leaves the rest alone.
          </p>
        </div>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {snapshot.partitions.length} partitions, replication factor {replicationFactor}
        </span>
      </div>

      {snapshot.partitions.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          The coordinator holds no allocation table, so create the index to spread '{snapshot.indexName}' over the
          cluster.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">Partition</th>
                <th className="px-3 py-2 text-left font-medium">State</th>
                <th className="px-3 py-2 text-left font-medium">Primary</th>
                <th className="px-3 py-2 text-right font-medium">Term</th>
                <th className="px-3 py-2 text-right font-medium">Copies</th>
                <th className="px-3 py-2 text-right font-medium">In sync</th>
                <th className="px-3 py-2 text-right font-medium">Commit</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.partitions.map(partition => (
                <PartitionRowView
                  key={partition.partitionId}
                  partition={partition}
                  replicationFactor={replicationFactor}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
