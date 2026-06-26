import { randomUUID } from 'node:crypto'
import { NarsilError } from '../errors'
import { serializeNarsilError } from './errors'
import type { TaskRecord, TaskType } from './types'

const DEFAULT_MAX_RETAINED = 1000

/**
 * In-memory registry for long-running operations (optimizeVectors, rebalance,
 * restore) that acknowledge with a task id the client polls. Records are lost on
 * restart; this is a single-node operational aid, not a durable job queue. The
 * registry caps retained records and evicts the oldest terminal tasks first so a
 * long-lived server cannot accumulate task state without bound.
 */
export class TaskRegistry {
  private readonly tasks = new Map<string, TaskRecord>()

  constructor(private readonly maxRetained = DEFAULT_MAX_RETAINED) {}

  /** Records a task as running and drives `op` to completion in the background.
   * Returns the record immediately so the caller can respond 202 with the id. */
  start(type: TaskType, indexName: string, op: () => Promise<void>): TaskRecord {
    const record: TaskRecord = {
      id: randomUUID(),
      type,
      indexName,
      status: 'running',
      createdAt: Date.now(),
      startedAt: Date.now(),
    }
    this.tasks.set(record.id, record)
    this.prune()
    void this.drive(record, op)
    return record
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id)
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()]
  }

  private async drive(record: TaskRecord, op: () => Promise<void>): Promise<void> {
    try {
      await op()
      record.status = 'succeeded'
    } catch (err) {
      record.status = 'failed'
      record.error =
        err instanceof NarsilError
          ? serializeNarsilError(err)
          : { code: 'INTERNAL_ERROR', message: 'The operation failed' }
    } finally {
      record.completedAt = Date.now()
    }
  }

  private prune(): void {
    if (this.tasks.size <= this.maxRetained) return
    for (const [id, record] of this.tasks) {
      if (this.tasks.size <= this.maxRetained) break
      if (record.status === 'succeeded' || record.status === 'failed') this.tasks.delete(id)
    }
  }
}
