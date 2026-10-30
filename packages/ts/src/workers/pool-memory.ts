import type { Executor } from './executor'
import { createRequestId } from './protocol'

export interface MemoryStats {
  workerId: number
  heapUsed: number
  heapTotal: number
  heapLimit: number | null
  external: number
}

interface MemoryReportPayload {
  heapUsed?: number
  heapTotal?: number
  heapLimit?: number | null
  external?: number
}

function toFinite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function toHeapLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export async function memoryStatsOf(slots: Iterable<[number, { executor: Executor }]>): Promise<MemoryStats[]> {
  const indices: number[] = []
  const pending: Array<Promise<MemoryReportPayload | null>> = []
  for (const [slotIndex, slot] of slots) {
    indices.push(slotIndex)
    pending.push(
      slot.executor
        .execute<MemoryReportPayload>({ type: 'memoryReport', requestId: createRequestId() })
        .catch(() => null),
    )
  }

  const reports = await Promise.all(pending)
  const stats: MemoryStats[] = []
  for (let n = 0; n < indices.length; n++) {
    const report = reports[n]
    stats.push({
      workerId: indices[n],
      heapUsed: toFinite(report?.heapUsed),
      heapTotal: toFinite(report?.heapTotal),
      heapLimit: toHeapLimit(report?.heapLimit),
      external: toFinite(report?.external),
    })
  }
  return stats
}
