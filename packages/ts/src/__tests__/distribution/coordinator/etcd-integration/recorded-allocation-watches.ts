import type { AllocationEvent, AllocationTable, ClusterCoordinator } from '../../../../distribution/coordinator/types'

export interface AllocationWatchRecord {
  delivered: Map<string, AllocationTable>
  stopped: boolean
}

export interface RecordedAllocationWatches {
  coordinator: ClusterCoordinator
  open(): AllocationWatchRecord[]
}

export function recordAllocationWatches(inner: ClusterCoordinator): RecordedAllocationWatches {
  const records = new Set<AllocationWatchRecord>()
  async function watchAllocation(handler: (event: AllocationEvent) => void): Promise<() => void> {
    const record: AllocationWatchRecord = { delivered: new Map(), stopped: false }
    records.add(record)
    try {
      const unwatch = await inner.watchAllocation(event => {
        handler(event)
        record.delivered.set(event.indexName, event.table)
      })
      return () => {
        record.stopped = true
        records.delete(record)
        unwatch()
      }
    } catch (error) {
      records.delete(record)
      throw error
    }
  }
  const coordinator = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'watchAllocation') return watchAllocation
      return Reflect.get(target, property, receiver)
    },
  })
  return {
    coordinator,
    open: () => [...records],
  }
}
