import type { IndexStats, PartitionStats } from '../../backend'
import { Badge } from '../ui/badge'

interface StatsTabProps {
  stats: IndexStats
  partitionStats: PartitionStats[]
}

function formatBytes(bytes: number): string {
  if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes < 0) return '--'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function StatsTab({ stats, partitionStats }: StatsTabProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Documents" value={stats.documentCount.toLocaleString()} />
        <StatCard label="Partitions" value={String(stats.partitionCount)} />
        <StatCard label="Memory" value={formatBytes(stats.memoryBytes)} />
        <StatCard label="Index Size" value={formatBytes(stats.indexSizeBytes)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border p-4">
          <h3 className="mb-2 text-sm font-semibold">Index Details</h3>
          <div className="flex flex-col gap-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Language</span>
              <Badge variant="secondary" className="text-[10px]">
                {stats.language}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Document Count</span>
              <span className="font-mono">{stats.documentCount.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Partition Count</span>
              <span className="font-mono">{stats.partitionCount}</span>
            </div>
          </div>
        </div>

        {partitionStats.length > 0 && (
          <div className="rounded-lg border p-4">
            <h3 className="mb-2 text-sm font-semibold">Partitions</h3>
            <div className="max-h-48 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="pb-1.5 text-left font-medium">ID</th>
                    <th className="pb-1.5 text-right font-medium">Docs</th>
                    <th className="pb-1.5 text-right font-medium">Memory</th>
                    <th className="pb-1.5 text-right font-medium">Vectors</th>
                  </tr>
                </thead>
                <tbody>
                  {partitionStats.map(p => (
                    <tr key={p.partitionId} className="border-b last:border-b-0">
                      <td className="py-1 font-mono">{p.partitionId}</td>
                      <td className="py-1 text-right font-mono">{p.documentCount.toLocaleString()}</td>
                      <td className="py-1 text-right font-mono">{formatBytes(p.estimatedMemoryBytes)}</td>
                      <td className="py-1 text-right font-mono">
                        {p.vectorFieldCount}
                        {p.isHnswPromoted && (
                          <Badge variant="secondary" className="ml-1 text-[9px]">
                            HNSW
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <span className="block font-mono text-2xl font-bold">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}
