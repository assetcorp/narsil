import { DEFAULT_MAX_RETAINED_TASKS } from './constants'
import type { TaskRecord, TaskStore } from './types'

/**
 * Default {@link TaskStore}: an in-process map, lost on restart and not shared
 * across instances. It caps how many records it keeps and evicts the oldest
 * terminal records first, so a long-lived server cannot accumulate task state
 * without bound. `ttlMs` is ignored here; the cap plays that role. Records are
 * copied in and out so a caller cannot mutate stored state by reference.
 *
 * @public
 */
export class InMemoryTaskStore implements TaskStore {
  private readonly records = new Map<string, TaskRecord>()

  /**
   * Builds a store that keeps task records in this process alone.
   *
   * @param maxRetained - Records to keep before the oldest finished ones are
   * dropped. Defaults to 1000.
   */
  constructor(private readonly maxRetained = DEFAULT_MAX_RETAINED_TASKS) {}

  /**
   * Stores a record, replacing whatever its id already held.
   *
   * @param record - The record to store. A copy is kept, so changing the
   * object afterwards leaves the store untouched.
   */
  async set(record: TaskRecord): Promise<void> {
    this.records.set(record.id, { ...record })
    this.prune()
  }

  /**
   * Reads one record back.
   *
   * @param id - The task to read.
   * @returns A copy of the record, or `null` when the store holds no such id.
   */
  async get(id: string): Promise<TaskRecord | null> {
    const record = this.records.get(id)
    return record ? { ...record } : null
  }

  /**
   * Lists every record the store holds.
   *
   * @returns A copy of each record, oldest first.
   */
  async list(): Promise<TaskRecord[]> {
    return [...this.records.values()].map(record => ({ ...record }))
  }

  /**
   * Removes one record. An id the store never held is not an error.
   *
   * @param id - The task to remove.
   */
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
