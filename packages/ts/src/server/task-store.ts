import type { TaskRecord, TaskStore } from './types'

const DEFAULT_MAX_RETAINED = 1000

/**
 * Default {@link TaskStore}: an in-process map, lost on restart and not shared
 * across instances. It caps how many records it keeps and evicts the oldest
 * terminal records first, so a long-lived server cannot accumulate task state
 * without bound. `ttlMs` is ignored here; the cap plays that role. Records are
 * copied in and out so a caller cannot mutate stored state by reference.
 */
export class InMemoryTaskStore implements TaskStore {
  private readonly records = new Map<string, TaskRecord>()

  constructor(private readonly maxRetained = DEFAULT_MAX_RETAINED) {}

  async set(record: TaskRecord): Promise<void> {
    this.records.set(record.id, { ...record })
    this.prune()
  }

  async get(id: string): Promise<TaskRecord | null> {
    const record = this.records.get(id)
    return record ? { ...record } : null
  }

  async list(): Promise<TaskRecord[]> {
    return [...this.records.values()].map(record => ({ ...record }))
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id)
  }

  private prune(): void {
    if (this.records.size <= this.maxRetained) return
    for (const [id, record] of this.records) {
      if (this.records.size <= this.maxRetained) break
      if (record.status === 'succeeded' || record.status === 'failed') this.records.delete(id)
    }
  }
}
