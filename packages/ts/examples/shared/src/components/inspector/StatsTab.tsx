import type { IndexStats, MemoryStatsResponse, PartitionStats } from '../../backend'
import { Badge } from '../ui/badge'

interface StatsTabProps {
  stats: IndexStats
  partitionStats: PartitionStats[]
  memoryStats: MemoryStatsResponse | null
}

function formatBytes(bytes: number): string {
  if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes < 0) return '--'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function StatsTab({ stats, partitionStats, memoryStats }: StatsTabProps) {
  const process = memoryStats?.process ?? null
  const workerCount = memoryStats?.workers.length ?? 0
  const workerHeapUsed = memoryStats?.workers.reduce((sum, worker) => sum + worker.heapUsed, 0) ?? 0

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Documents" value={stats.documentCount.toLocaleString()} />
        <StatCard label="Partitions" value={String(stats.partitionCount)} />
        <StatCard label="Estimated Memory" value={formatBytes(stats.estimatedMemoryBytes)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0 rounded-lg border p-4">
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
          <div className="min-w-0 rounded-lg border p-4">
            <h3 className="mb-2 text-sm font-semibold">Partitions</h3>
            <div className="max-h-48 overflow-auto">
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="min-w-0 rounded-lg border p-4">
          <h3 className="mb-2 text-sm font-semibold">Runtime Memory</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Metric label="Estimated index bytes" value={formatBytes(memoryStats?.estimatedIndexBytes ?? 0)} />
            <Metric label="Worker heap" value={formatBytes(workerHeapUsed)} />
            <Metric
              label="Process heap used"
              value={process === null ? 'Unavailable' : formatBytes(process.heapUsed)}
            />
            <Metric label="Process RSS" value={process === null ? 'Unavailable' : formatBytes(process.rss)} />
          </div>
        </div>

        <div className="min-w-0 rounded-lg border p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Worker Reports</h3>
            <Badge variant="secondary" className="text-[10px]">
              {workerCount} active
            </Badge>
          </div>
          {memoryStats === null || memoryStats.workers.length === 0 ? (
            <p className="text-xs text-muted-foreground">The engine is running on the main thread for this dataset.</p>
          ) : (
            <div className="max-h-48 overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="pb-1.5 text-left font-medium">Worker</th>
                    <th className="pb-1.5 text-right font-medium">Heap Used</th>
                    <th className="pb-1.5 text-right font-medium">Heap Total</th>
                    <th className="pb-1.5 text-right font-medium">External</th>
                  </tr>
                </thead>
                <tbody>
                  {memoryStats.workers.map(worker => (
                    <tr key={worker.workerId} className="border-b last:border-b-0">
                      <td className="py-1 font-mono">{worker.workerId}</td>
                      <td className="py-1 text-right font-mono">{formatBytes(worker.heapUsed)}</td>
                      <td className="py-1 text-right font-mono">{formatBytes(worker.heapTotal)}</td>
                      <td className="py-1 text-right font-mono">{formatBytes(worker.external)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border p-4">
      <span className="block font-mono text-2xl font-bold">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="block truncate font-mono text-sm font-semibold">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}
