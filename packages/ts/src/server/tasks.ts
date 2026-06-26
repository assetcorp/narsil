import { randomUUID } from 'node:crypto'
import { NarsilError } from '../errors'
import { serializeNarsilError } from './errors'
import type { TaskRecord, TaskStore, TaskType } from './types'

const RUNNING_TTL_MS = 24 * 60 * 60 * 1000
const TERMINAL_TTL_MS = 60 * 60 * 1000

/**
 * Drives long-running operations (optimizeVectors, rebalance, restore) that
 * acknowledge with a task id the client polls. The status of every task lives in
 * a pluggable {@link TaskStore}; the default is in-process and lost on restart,
 * but a shared store lets any instance report a task and lets status survive a
 * restart. The work itself still runs in this process against the in-memory
 * engine, so a shared store gives cross-instance visibility, not durable or
 * distributed execution.
 */
export class TaskRegistry {
  constructor(
    private readonly store: TaskStore,
    private readonly instanceId: string,
  ) {}

  /** Records a task as running and drives `op` to completion in the background.
   * Returns the record once it is persisted so the caller can respond 202. */
  async start(type: TaskType, indexName: string, op: () => Promise<void>): Promise<TaskRecord> {
    const now = Date.now()
    const record: TaskRecord = {
      id: randomUUID(),
      type,
      indexName,
      owner: this.instanceId,
      status: 'running',
      createdAt: now,
      startedAt: now,
    }
    await this.store.set(record, RUNNING_TTL_MS)
    void this.drive(record, op)
    return record
  }

  get(id: string): Promise<TaskRecord | null> {
    return this.store.get(id)
  }

  list(): Promise<TaskRecord[]> {
    return this.store.list()
  }

  /** Fails this instance's previously-running tasks after a restart. A task can
   * only be advanced by the process that owns it, so its own running tasks from
   * a prior life are dead and must not keep showing a stale running status. This
   * is effective only with a stable instanceId; with the default random id it
   * finds none of its own prior tasks, which is also correct for the in-memory
   * default (which starts empty). */
  async reconcile(): Promise<void> {
    let records: TaskRecord[]
    try {
      records = await this.store.list()
    } catch {
      return
    }
    for (const record of records) {
      if (record.owner !== this.instanceId) continue
      if (record.status !== 'running' && record.status !== 'queued') continue
      const failed: TaskRecord = {
        ...record,
        status: 'failed',
        completedAt: Date.now(),
        error: { code: 'TASK_INTERRUPTED', message: 'The server restarted while this task was running' },
      }
      try {
        await this.store.set(failed, TERMINAL_TTL_MS)
      } catch {
        // best effort; a store failure here must not block startup
      }
    }
  }

  private async drive(record: TaskRecord, op: () => Promise<void>): Promise<void> {
    const result: TaskRecord = { ...record }
    try {
      await op()
      result.status = 'succeeded'
    } catch (err) {
      result.status = 'failed'
      result.error =
        err instanceof NarsilError
          ? serializeNarsilError(err)
          : { code: 'INTERNAL_ERROR', message: 'The operation failed' }
    }
    result.completedAt = Date.now()
    try {
      await this.store.set(result, TERMINAL_TTL_MS)
    } catch {
      // the operation already ran; persisting its terminal status is best effort
    }
  }
}
